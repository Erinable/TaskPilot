// Reads repository files for an agent, within a fixed boundary.
//
// SECURITY: this is the only place agent-bound file contents come from.
//   - Contents are read from git's index blobs (`git cat-file --batch`),
//     never from the filesystem. Only tracked files can be read, a symlink
//     yields its target path rather than the target's contents, and nothing
//     outside the repository is reachable.
//   - Paths must appear in `git ls-files`; anything else is refused.
//   - Files that commonly hold secrets are refused even when tracked.
//   - Binary files, oversized files, and totals past the budget are skipped.
// Every skip is reported back so the caller (and the user) can see what the
// agent did not get.
//
// A call runs three git processes however many files it reads: ls-files,
// one `cat-file --batch-check` for every size, one `cat-file --batch` that
// returns the contents of the files the limits let through, one at a time.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const run = promisify(execFile);

export const DEFAULT_LIMITS = { maxFiles: 12, maxFileBytes: 24 * 1024, maxTotalBytes: 120 * 1024 };

export type ReadLimits = typeof DEFAULT_LIMITS;

// A git index entry; mode 120000 is a symlink, 160000 a submodule.
export interface IndexEntry {
  mode: string;
  sha: string;
}

// A tracked file's contents read from its blob.
export interface TrackedFile {
  path: string;
  sha: string;
  content: string;
  bytes: number;
}

export type ReadSkipReason = 'not_tracked' | 'secret' | 'not_a_file' | 'file_limit' | 'too_large' | 'budget' | 'binary';

export interface ReadSkip {
  path: string;
  reason: ReadSkipReason;
}

export interface TrackedRead {
  files: TrackedFile[];
  skipped: ReadSkip[];
}

// Matched against the file's basename and full path, case-insensitively.
const SECRET_PATTERNS = [
  /^\.env($|\.)/,
  /^\.npmrc$/,
  /^\.pypirc$/,
  /^\.netrc$/,
  /^\.git-credentials$/,
  /\.(pem|key|p12|pfx|jks|keystore|crt|cer|der|asc|gpg|kdbx)$/,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/,
  /(^|[-_.])(secret|secrets|credential|credentials|password|passwords)([-_.]|$)/,
  /(^|\/)\.aws\/|(^|\/)\.ssh\//,
  /serviceaccount.*\.json$/,
  /^terraform\.tfstate/,
];

export const looksSecret = (file: string): boolean => {
  const lower = file.toLowerCase();
  const base = path.posix.basename(lower);
  return SECRET_PATTERNS.some((pattern) => pattern.test(base) || pattern.test(lower));
};

// A NUL byte in the first 8 KiB is git's own binary heuristic.
export const looksBinary = (buffer: Buffer): boolean => buffer.subarray(0, 8192).includes(0);

const git = async (root: string, args: string[]): Promise<Buffer> => {
  const { stdout } = await run('git', args, { cwd: root, maxBuffer: 16 * 1024 * 1024, encoding: 'buffer' });
  return stdout;
};

// Sizes of `shas` in one `git cat-file --batch-check`; a missing object is absent.
const blobSizes = async (root: string, shas: string[]): Promise<Map<string, number>> => {
  const sizes = new Map<string, number>();
  if (!shas.length) return sizes;
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const child = spawn('git', ['cat-file', '--batch-check=%(objectname) %(objectsize)'], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  const chunks: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
  child.stdin.on('error', () => {});
  child.on('error', reject);
  child.on('close', (code) =>
    code === 0 ? resolve(Buffer.concat(chunks).toString('utf8')) : reject(new Error(`git cat-file --batch-check failed with ${code}`)),
  );
  child.stdin.end(`${shas.join('\n')}\n`);
  for (const line of (await promise).split('\n')) {
    const [sha, size] = line.split(' ');
    if (sha && /^\d+$/.test(size ?? '')) sizes.set(sha, Number(size));
  }
  return sizes;
};

// One `git cat-file --batch` process answering blob requests in order.
// Each answer is "<sha> <type> <size>\n<content>\n", or "<sha> missing\n".
const blobReader = (root: string) => {
  const child = spawn('git', ['cat-file', '--batch'], { cwd: root, stdio: ['pipe', 'pipe', 'ignore'] });
  let buffered = Buffer.alloc(0);
  let failure: Error | null = null;
  const waiting: { resolve: (blob: Buffer | null) => void; reject: (error: Error) => void }[] = [];
  const drain = () => {
    while (waiting.length) {
      const newline = buffered.indexOf(0x0a);
      if (newline < 0) return;
      const header = buffered.subarray(0, newline).toString('utf8').split(' ');
      if (header[1] === 'missing') {
        buffered = buffered.subarray(newline + 1);
        (waiting.shift() as (typeof waiting)[number]).resolve(null);
        continue;
      }
      const size = Number(header[2]);
      if (buffered.length < newline + 1 + size + 1) return;
      const blob = Buffer.from(buffered.subarray(newline + 1, newline + 1 + size));
      buffered = buffered.subarray(newline + 1 + size + 1);
      (waiting.shift() as (typeof waiting)[number]).resolve(blob);
    }
  };
  const fail = (error: Error) => {
    failure ??= error;
    for (const entry of waiting.splice(0)) entry.reject(failure);
  };
  child.stdout.on('data', (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    drain();
  });
  child.stdin.on('error', () => {});
  child.on('error', fail);
  child.on('close', (code) => fail(new Error(`git cat-file --batch exited with ${code}`)));
  return {
    read: (sha: string): Promise<Buffer | null> => {
      if (failure) return Promise.reject(failure);
      const { promise, resolve, reject } = Promise.withResolvers<Buffer | null>();
      waiting.push({ resolve, reject });
      child.stdin.write(`${sha}\n`);
      return promise;
    },
    close: () => {
      child.stdin.end();
    },
  };
};

// Index entries for tracked files: path → { sha, mode }. Mode 120000 is a
// symlink, 160000 a submodule; neither has readable contents here.
export const indexEntries = async (root: string): Promise<Map<string, IndexEntry>> => {
  const raw = (await git(root, ['ls-files', '-s', '-z'])).toString('utf8');
  const entries = new Map<string, IndexEntry>();
  for (const record of raw.split('\0')) {
    if (!record) continue;
    // "<mode> <sha> <stage>\t<path>"
    const tab = record.indexOf('\t');
    const [mode, sha, stage] = record.slice(0, tab).split(' ');
    if (stage !== '0') continue; // unresolved merge conflicts
    entries.set(record.slice(tab + 1), { mode, sha });
  }
  return entries;
};

// Why a requested path is refused before git is asked for its blob, or null.
const refusal = (candidate: string, entry: IndexEntry | undefined): ReadSkipReason | null => {
  if (!entry) return 'not_tracked';
  if (looksSecret(candidate)) return 'secret';
  return entry.mode === '120000' || entry.mode === '160000' ? 'not_a_file' : null;
};

// root: repository root (already validated as a git repo)
// requested: relative paths, in priority order
export const readTracked = async (root: string, requested: unknown[], limits: Partial<ReadLimits> = {}): Promise<TrackedRead> => {
  const { maxFiles, maxFileBytes, maxTotalBytes } = { ...DEFAULT_LIMITS, ...limits };
  const entries = await indexEntries(root);
  const files: TrackedFile[] = [];
  const skipped: ReadSkip[] = [];
  let total = 0;
  const seen = new Set<string>();

  // Paths, secrets and links are judged before git is asked for anything.
  const candidates: { path: string; sha: string }[] = [];
  for (const candidate of requested) {
    if (typeof candidate !== 'string' || seen.has(candidate)) continue;
    seen.add(candidate);
    const entry = entries.get(candidate);
    const reason = refusal(candidate, entry);
    candidates.push({ path: candidate, sha: reason ? '' : (entry as IndexEntry).sha });
    if (reason) skipped.push({ path: candidate, reason });
  }
  const sizes = await blobSizes(root, [...new Set(candidates.filter((item) => item.sha).map((item) => item.sha))]);
  let reader: ReturnType<typeof blobReader> | null = null;
  try {
    for (const { path: candidate, sha } of candidates) {
      if (!sha) continue;
      const skip = (reason: ReadSkipReason) => skipped.push({ path: candidate, reason });
      if (files.length >= maxFiles) {
        skip('file_limit');
        continue;
      }
      const size = sizes.get(sha);
      if (size === undefined) throw new Error(`git has no blob ${sha} for ${candidate}`);
      if (size > maxFileBytes) {
        skip('too_large');
        continue;
      }
      if (total + size > maxTotalBytes) {
        skip('budget');
        continue;
      }
      reader ??= blobReader(root);
      const blob = await reader.read(sha);
      if (!blob) throw new Error(`git has no blob ${sha} for ${candidate}`);
      if (looksBinary(blob)) {
        skip('binary');
        continue;
      }
      total += blob.length;
      files.push({ path: candidate, sha, content: blob.toString('utf8'), bytes: blob.length });
    }
  } finally {
    reader?.close();
  }
  // Skips are reported in the order the paths were requested.
  const order = new Map(candidates.map((item, index) => [item.path, index]));
  skipped.sort((left, right) => (order.get(left.path) as number) - (order.get(right.path) as number));
  return { files, skipped };
};
