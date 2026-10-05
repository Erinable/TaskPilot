// Reads repository files for an agent, within a fixed boundary.
//
// SECURITY: this is the only place agent-bound file contents come from.
//   - Contents are read from git's index blobs (`git cat-file blob <sha>`),
//     never from the filesystem. Only tracked files can be read, a symlink
//     yields its target path rather than the target's contents, and nothing
//     outside the repository is reachable.
//   - Paths must appear in `git ls-files`; anything else is refused.
//   - Files that commonly hold secrets are refused even when tracked.
//   - Binary files, oversized files, and totals past the budget are skipped.
// Every skip is reported back so the caller (and the user) can see what the
// agent did not get.
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');

const run = promisify(execFile);

const DEFAULT_LIMITS = { maxFiles: 12, maxFileBytes: 24 * 1024, maxTotalBytes: 120 * 1024 };

// Matched against the file's basename and full path, case-insensitively.
const SECRET_PATTERNS = [
  /^\.env($|\.)/, /^\.npmrc$/, /^\.pypirc$/, /^\.netrc$/, /^\.git-credentials$/,
  /\.(pem|key|p12|pfx|jks|keystore|crt|cer|der|asc|gpg|kdbx)$/,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/,
  /(^|[-_.])(secret|secrets|credential|credentials|password|passwords)([-_.]|$)/,
  /(^|\/)\.aws\/|(^|\/)\.ssh\//,
  /serviceaccount.*\.json$/, /^terraform\.tfstate/,
];

function looksSecret(file) {
  const lower = file.toLowerCase();
  const base = path.posix.basename(lower);
  return SECRET_PATTERNS.some((pattern) => pattern.test(base) || pattern.test(lower));
}

/** A NUL byte in the first 8 KiB is git's own binary heuristic. */
function looksBinary(buffer) {
  return buffer.subarray(0, 8192).includes(0);
}

async function git(root, args, options = {}) {
  const { stdout } = await run('git', args, { cwd: root, maxBuffer: 16 * 1024 * 1024, encoding: 'buffer', ...options });
  return stdout;
}

/**
 * Index entries for tracked files: path → { sha, mode }. Mode 120000 is a
 * symlink, 160000 a submodule; neither has readable contents here.
 */
async function indexEntries(root) {
  const raw = (await git(root, ['ls-files', '-s', '-z'])).toString('utf8');
  const entries = new Map();
  for (const record of raw.split('\0')) {
    if (!record) continue;
    // "<mode> <sha> <stage>\t<path>"
    const tab = record.indexOf('\t');
    const [mode, sha, stage] = record.slice(0, tab).split(' ');
    if (stage !== '0') continue; // unresolved merge conflicts
    entries.set(record.slice(tab + 1), { mode, sha });
  }
  return entries;
}

/**
 * @param root repository root (already validated as a git repo)
 * @param requested relative paths, in priority order
 * @returns {{ files: [{path, sha, content, bytes}], skipped: [{path, reason}] }}
 */
async function readTracked(root, requested, limits = {}) {
  const { maxFiles, maxFileBytes, maxTotalBytes } = { ...DEFAULT_LIMITS, ...limits };
  const entries = await indexEntries(root);
  const files = [];
  const skipped = [];
  let total = 0;
  const seen = new Set();

  for (const candidate of requested) {
    if (typeof candidate !== 'string' || seen.has(candidate)) continue;
    seen.add(candidate);
    const skip = (reason) => skipped.push({ path: candidate, reason });
    const entry = entries.get(candidate);
    if (!entry) { skip('not_tracked'); continue; }
    if (looksSecret(candidate)) { skip('secret'); continue; }
    if (entry.mode === '120000' || entry.mode === '160000') { skip('not_a_file'); continue; }
    if (files.length >= maxFiles) { skip('file_limit'); continue; }

    const size = Number((await git(root, ['cat-file', '-s', entry.sha])).toString().trim());
    if (size > maxFileBytes) { skip('too_large'); continue; }
    if (total + size > maxTotalBytes) { skip('budget'); continue; }

    const blob = await git(root, ['cat-file', 'blob', entry.sha]);
    if (looksBinary(blob)) { skip('binary'); continue; }
    total += blob.length;
    files.push({ path: candidate, sha: entry.sha, content: blob.toString('utf8'), bytes: blob.length });
  }
  return { files, skipped };
}

module.exports = { DEFAULT_LIMITS, looksSecret, looksBinary, indexEntries, readTracked };
