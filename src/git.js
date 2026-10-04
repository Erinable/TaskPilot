// Read-only git access for the workspace. TaskPilot observes the repository
// while the developer works in their own editor; nothing here mutates history
// or the working tree.
//
// Every call uses execFile with an argument array (never a shell string), so
// branch names and paths cannot inject commands.
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const path = require('node:path');

const run = promisify(execFile);
const MAX_BUFFER = 20 * 1024 * 1024; // diffs of a work package can be large

class GitError extends Error {
  constructor(message, { code, stderr } = {}) {
    super(message);
    this.name = 'GitError';
    this.code = code;
    this.stderr = stderr;
  }
}

async function git(cwd, args) {
  try {
    const { stdout } = await run('git', args, { cwd, maxBuffer: MAX_BUFFER });
    return stdout;
  } catch (error) {
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
}

async function isRepo(cwd) {
  try {
    return (await git(cwd, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * The repository's top-level directory. Diff paths are always relative to it,
 * so the workspace root is normalized to this to keep file scopes aligned.
 */
async function topLevel(cwd) {
  return (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
}

async function head(cwd) {
  return (await git(cwd, ['rev-parse', 'HEAD'])).trim();
}

async function currentBranch(cwd) {
  const branch = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  return branch === 'HEAD' ? null : branch; // detached
}

/** Parses `git status --porcelain=v1 -z` into {path, status, staged, untracked}. */
function parseStatus(raw) {
  const entries = [];
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
}

async function status(cwd) {
  return parseStatus(await git(cwd, ['status', '--porcelain=v1', '-z']));
}

/** Per-file added/removed line counts since `baseline`, including the worktree. */
async function diffStat(cwd, baseline) {
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
}

/**
 * diffStat() plus files git does not know about yet.
 *
 * `git diff` only reports tracked paths, so a brand new file is invisible to
 * it — and a new file outside the work package's scope is the most common
 * shape an out-of-scope change takes. Counting it as an addition keeps the
 * scope check honest.
 */
async function changesSince(cwd, baseline) {
  const [tracked, entries] = await Promise.all([diffStat(cwd, baseline), status(cwd)]);
  const known = new Set(tracked.map((change) => change.path));
  const untracked = [];

  for (const entry of entries) {
    if (!entry.untracked || known.has(entry.path)) continue;
    untracked.push({
      path: entry.path,
      ...(await countAddedLines(cwd, entry.path)),
      untracked: true,
    });
  }
  return [...tracked, ...untracked];
}

/** Line count for an untracked file; binary or unreadable files report 0. */
async function countAddedLines(cwd, filePath) {
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
}

/** Unified diff for one file since `baseline`. `--` guards paths like `-foo`. */
async function diffFile(cwd, baseline, filePath) {
  const patch = await git(cwd, ['diff', baseline, '--', filePath]);
  if (patch.trim()) return patch;
  // Untracked files produce no diff; `--no-index` against /dev/null shows the
  // additions. It exits non-zero when the files differ, which is the norm here.
  try {
    return await git(cwd, ['diff', '--no-index', '--', '/dev/null', filePath]);
  } catch (error) {
    return error.stdout ?? patch;
  }
}

/** Summary used by the workspace header and as a work package baseline. */
async function describe(cwd) {
  const [commit, branch, entries] = await Promise.all([head(cwd), currentBranch(cwd), status(cwd)]);
  return { commit, branch, dirty: entries.length > 0, changedFiles: entries.length };
}

module.exports = {
  GitError, isRepo, topLevel, head, currentBranch, status, parseStatus,
  diffStat, changesSince, diffFile, describe,
};
