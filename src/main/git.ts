// Read-only git access for the workspace. TaskPilot observes the repository
// while the developer works in their own editor; nothing here mutates history
// or the working tree.
//
// Every call uses execFile with an argument array (never a shell string), so
// branch names and paths cannot inject commands.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { looksSecret } from './repo_reader.ts';

const run = promisify(execFile);
const MAX_BUFFER = 20 * 1024 * 1024; // diffs of a work package can be large

// One line of `git status`.
export interface StatusEntry {
  path: string;
  status: string;
  staged: boolean;
  untracked: boolean;
}

// Added/removed line counts for one changed file.
export interface FileChange {
  path: string;
  added: number;
  removed: number;
  binary: boolean;
  untracked: boolean;
}

// The workspace header summary, also used as a work package baseline.
export interface RepoDescription {
  commit: string;
  branch: string | null;
  dirty: boolean;
  changedFiles: number;
}

export type GitErrorCode = 'git_missing' | 'git_failed';

export class GitError extends Error {
  code?: GitErrorCode;
  stderr?: string;
  stdout?: string;

  constructor(message: string, { code, stderr }: { code?: GitErrorCode; stderr?: string } = {}) {
    super(message);
    this.name = 'GitError';
    this.code = code;
    this.stderr = stderr;
  }
}

const git = async (cwd: string, args: string[]): Promise<string> => {
  try {
    const { stdout } = await run('git', args, { cwd, maxBuffer: MAX_BUFFER });
    return stdout;
  } catch (caught) {
    const error = caught as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    if (error.code === 'ENOENT') {
      throw new GitError('git executable not found on PATH', { code: 'git_missing' });
    }
    const failure = new GitError(`git ${args[0]} failed`, {
      code: 'git_failed',
      stderr: error.stderr?.trim(),
    });
    // Some invocations (notably `diff --no-index`) exit non-zero on success,
    // so keep whatever they printed for the caller to decide.
    failure.stdout = error.stdout;
    throw failure;
  }
};

export const isRepo = async (cwd: string): Promise<boolean> => {
  try {
    return (await git(cwd, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true';
  } catch {
    return false;
  }
};

// The repository's top-level directory. Diff paths are always relative to it,
// so the workspace root is normalized to this to keep file scopes aligned.
export const topLevel = async (cwd: string): Promise<string> => (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();

// Tracked file paths, for giving an agent a sense of the repository layout.
// Only paths, never contents; untracked and ignored files are excluded, which
// keeps local secrets like .env out of the list. Returns at most `limit`
// paths, shallowest first so the overall structure survives truncation.
export const listFiles = async (cwd: string, { limit = 400 }: { limit?: number } = {}): Promise<string[]> => {
  const raw = await git(cwd, ['ls-files', '-z']);
  // Secret-looking paths are left out entirely, even though they are tracked:
  // agents get neither their contents (see repo_reader.js) nor their names.
  const files = raw.split('\0').filter((file) => file && !looksSecret(file));
  files.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  return files.slice(0, limit);
};

export const head = async (cwd: string): Promise<string> => (await git(cwd, ['rev-parse', 'HEAD'])).trim();

export const currentBranch = async (cwd: string): Promise<string | null> => {
  const branch = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  return branch === 'HEAD' ? null : branch; // detached
};

// Parses `git status --porcelain=v1 -z` into {path, status, staged, untracked}.
export const parseStatus = (raw: string): StatusEntry[] => {
  const entries: StatusEntry[] = [];
  const fields = raw.split('\0');
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i];
    if (!field) continue;
    const code = field.slice(0, 2);
    let filePath = field.slice(3);
    // Renames/copies emit the destination then the source as a separate field.
    if (code[0] === 'R' || code[0] === 'C') {
      i += 1;
      filePath = `${fields[i]} → ${filePath}`;
    }
    entries.push({
      path: filePath,
      status: code,
      staged: code[0] !== ' ' && code[0] !== '?',
      untracked: code === '??',
    });
  }
  return entries;
};

export const status = async (cwd: string): Promise<StatusEntry[]> => {
  // --untracked-files=all lists each file in a new directory; the default
  // collapses it to "dir/", which no file scope can match and which hides
  // the new files from review.
  return parseStatus(await git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']));
};

// Per-file added/removed line counts since `baseline`, including the worktree.
export const diffStat = async (cwd: string, baseline: string): Promise<FileChange[]> => {
  const raw = await git(cwd, ['diff', '--numstat', '-z', baseline, '--']);
  const fields = raw.split('\0').filter(Boolean);
  return fields.map((line) => {
    const [added, removed, filePath] = line.split('\t');
    const binary = added === '-' || removed === '-';
    return {
      path: filePath,
      added: binary ? 0 : Number(added),
      removed: binary ? 0 : Number(removed),
      binary,
      untracked: false,
    };
  });
};

// Line count for an untracked file; binary or unreadable files report 0.
const countAddedLines = async (cwd: string, filePath: string): Promise<Pick<FileChange, 'added' | 'removed' | 'binary'>> => {
  try {
    const contents = await fs.readFile(path.join(cwd, filePath));
    if (contents.includes(0)) return { added: 0, removed: 0, binary: true };
    const text = contents.toString('utf8');
    const lines = text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    return { added: lines, removed: 0, binary: false };
  } catch {
    // A directory entry or a file removed between the two calls.
    return { added: 0, removed: 0, binary: false };
  }
};

// diffStat() plus files git does not know about yet.
//
// `git diff` only reports tracked paths, so a brand new file is invisible to
// it — and a new file outside the work package's scope is the most common
// shape an out-of-scope change takes. Counting it as an addition keeps the
// scope check honest.
export const changesSince = async (cwd: string, baseline: string): Promise<FileChange[]> => {
  const [tracked, entries] = await Promise.all([diffStat(cwd, baseline), status(cwd)]);
  const known = new Set(tracked.map((change) => change.path));
  const untracked: FileChange[] = [];

  for (const entry of entries) {
    if (!entry.untracked || known.has(entry.path)) continue;
    untracked.push({
      path: entry.path,
      ...(await countAddedLines(cwd, entry.path)),
      untracked: true,
    });
  }
  return [...tracked, ...untracked];
};

// Unified diff for one file since `baseline`. `--` guards paths like `-foo`.
export const diffFile = async (cwd: string, baseline: string, filePath: string): Promise<string> => {
  const patch = await git(cwd, ['diff', baseline, '--', filePath]);
  if (patch.trim()) return patch;
  // Untracked files produce no diff; `--no-index` against /dev/null shows the
  // additions. It exits non-zero when the files differ, which is the norm here.
  try {
    return await git(cwd, ['diff', '--no-index', '--', '/dev/null', filePath]);
  } catch (error) {
    return (error as GitError).stdout ?? patch;
  }
};

// Summary used by the workspace header and as a work package baseline.
export const describe = async (cwd: string): Promise<RepoDescription> => {
  const [commit, branch, entries] = await Promise.all([head(cwd), currentBranch(cwd), status(cwd)]);
  return { commit, branch, dirty: entries.length > 0, changedFiles: entries.length };
};

// One commit as release notes see it; `date` is the committer date (ISO).
export interface CommitInfo {
  sha: string;
  subject: string;
  date: string;
}

// Fields split by the unit separator, records by NUL, so subjects with any
// printable text parse safely.
const COMMIT_FORMAT = '--format=%H%x1f%cI%x1f%s%x00';

const parseCommits = (raw: string): CommitInfo[] => raw.split('\0').map((record) => record.replace(/^\n/, '')).filter(Boolean).map((record) => {
  const [sha, date, subject = ''] = record.split('\x1f');
  return { sha, subject, date };
});

// The full sha `ref` resolves to as a commit, or null when it does not.
export const resolveCommit = async (cwd: string, ref: string): Promise<string | null> => {
  // A leading dash would be read as an option.
  if (!ref || ref.startsWith('-')) return null;
  try {
    return (await git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).trim() || null;
  } catch {
    return null;
  }
};

// The newest tag reachable from HEAD, with the commit it points at.
export const latestTag = async (cwd: string): Promise<{ name: string; commit: string } | null> => {
  let name: string;
  try {
    name = (await git(cwd, ['describe', '--tags', '--abbrev=0', 'HEAD'])).trim();
  } catch {
    return null; // no tags, or no commits
  }
  const commit = name ? await resolveCommit(cwd, `refs/tags/${name}`) : null;
  return commit ? { name, commit } : null;
};

export const isAncestor = async (cwd: string, ancestor: string, descendant: string): Promise<boolean> => {
  try {
    await git(cwd, ['merge-base', '--is-ancestor', ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
};

// The newest `limit` commits reachable from HEAD.
export const recentCommits = async (cwd: string, { limit }: { limit: number }): Promise<CommitInfo[]> => {
  try {
    return parseCommits(await git(cwd, ['log', `--max-count=${limit}`, COMMIT_FORMAT, 'HEAD', '--']));
  } catch {
    return []; // no commits yet
  }
};

// Commits in start..end, newest first, at most `limit`; `truncated` when more exist.
export const commitRange = async (cwd: string, start: string, end: string, { limit }: { limit: number }): Promise<{ commits: CommitInfo[]; truncated: boolean }> => {
  const commits = parseCommits(await git(cwd, ['log', `--max-count=${limit + 1}`, COMMIT_FORMAT, `${start}..${end}`, '--']));
  return { commits: commits.slice(0, limit), truncated: commits.length > limit };
};

// How many commits start..end holds, counting at most `limit`.
export const countRange = async (cwd: string, start: string, end: string, { limit }: { limit: number }): Promise<number> =>
  Number((await git(cwd, ['rev-list', '--count', `--max-count=${limit}`, `${start}..${end}`, '--'])).trim());

// Per-file line counts between two commits, committed history only. Renames
// are reported under their new path.
export const rangeStat = async (cwd: string, start: string, end: string): Promise<Omit<FileChange, 'untracked'>[]> => {
  const fields = (await git(cwd, ['diff', '--numstat', '-z', '--no-renames', start, end, '--'])).split('\0').filter(Boolean);
  return fields.map((line) => {
    const [added, removed, filePath] = line.split('\t');
    const binary = added === '-' || removed === '-';
    return { path: filePath, added: binary ? 0 : Number(added), removed: binary ? 0 : Number(removed), binary };
  });
};

// A tracked file's contents at `commit`, or null when it is not in that tree.
export const showFile = async (cwd: string, commit: string, filePath: string): Promise<string | null> => {
  try {
    return await git(cwd, ['show', `${commit}:${filePath}`]);
  } catch {
    return null;
  }
};
