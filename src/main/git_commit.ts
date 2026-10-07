// The one place TaskPilot writes git history: committing a finished work
// package's files after the developer reviews them and clicks. git.ts stays
// read-only; nothing else here stages, commits, pushes or touches the index
// beyond the paths it is given.
//
// [人工决策-2026-10-07 16:08:33] 为服务编程初学者，打破「只读仓库」原则仅限这一个动作：用户确认后由 TaskPilot 只提交该工作包文件范围内改动过的文件（GitHub Desktop 式），从不推送、不改分支、不 amend；范围外和可能含密钥的文件不提交，列出来让用户自己处理。
//
// Every call uses execFile with an argument array and `--` before paths.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import * as git from './git.ts';
import { looksSecret } from './repo_reader.ts';

const run = promisify(execFile);

export const MAX_SUBJECT = 72;
export const MAX_MESSAGE = 2000;

export type CommitErrorCode = 'nothing_to_commit' | 'invalid_message' | 'commit_failed' | 'changes_changed' | 'git_identity';

const fail = (message: string, code: CommitErrorCode): never => {
  throw Object.assign(new Error(message), { code });
};

// A commit message: a non-empty first line, no control characters but
// newlines and tabs, bounded in size.
export const validateMessage = (raw: unknown): string => {
  if (typeof raw !== 'string') return fail('The commit message must be text', 'invalid_message');
  const message = raw.replace(/\r\n?/g, '\n').trim();
  const subject = message.split('\n')[0].trim();
  if (!subject) return fail('The commit message needs a first line', 'invalid_message');
  // eslint-disable-next-line no-control-regex
  if (/[\0-\x08\x0b-\x1f\x7f]/.test(message)) return fail('The commit message has control characters', 'invalid_message');
  if (message.length > MAX_MESSAGE) return fail('The commit message is too long', 'invalid_message');
  return message;
};

export type SkipReason = 'out_of_scope' | 'secret' | 'rename';

// Uncommitted changes (git status, so already-committed work is not listed
// again) split into what may be committed (inside the package's file scope)
// and what is held back. Renames show as
// "old → new" and are held back, as are secret-looking paths: the developer
// commits those by hand if they mean to.
export const classifyChanges = (changes: { path: string }[], fileScope: string[]) => {
  const scope = new Set(fileScope);
  const committable: string[] = [];
  const skipped: { path: string; reason: SkipReason }[] = [];
  for (const change of changes) {
    if (change.path.includes(' → ')) skipped.push({ path: change.path, reason: 'rename' });
    else if (looksSecret(change.path)) skipped.push({ path: change.path, reason: 'secret' });
    else if (!scope.has(change.path)) skipped.push({ path: change.path, reason: 'out_of_scope' });
    else committable.push(change.path);
  }
  return { committable, skipped };
};

// What may be committed for a package right now.
export const preview = async (root: string, fileScope: string[]) => classifyChanges(await git.status(root), fileScope);

// Commits exactly the files the developer reviewed, recomputed here: if the
// list changed since they looked, nothing is committed and they look again.
// Stages the paths (additions, edits and deletions) and commits them with the
// developer's own git identity. Anything they had staged before is left out:
// `--only` commits the listed paths alone. `--no-verify` is never passed, so
// their hooks still run.
export const commitPaths = async (root: string, fileScope: string[], reviewed: string[], message: string): Promise<string> => {
  const { committable: paths } = await preview(root, fileScope);
  if (paths.length === 0) return fail('There is nothing to commit', 'nothing_to_commit');
  if (paths.length !== reviewed.length || paths.some((file) => !reviewed.includes(file))) {
    return fail('The changed files are not the ones reviewed', 'changes_changed');
  }
  try {
    // `add -A -- paths` records deletions of listed paths too.
    await run('git', ['add', '-A', '--', ...paths], { cwd: root });
    await run('git', ['commit', '--only', '-m', message, '--', ...paths], { cwd: root, maxBuffer: 4 * 1024 * 1024 });
  } catch (caught) {
    const error = caught as { stderr?: string; message: string };
    console.error('[git_commit] commit failed', caught);
    // A fresh git install has no name or email; commits refuse until set.
    if (/tell me who you are|user\.(name|email)/i.test(error.stderr ?? '')) fail('git has no user name or email', 'git_identity');
    throw Object.assign(new Error((error.stderr ?? error.message).trim().slice(0, 600)), { code: 'commit_failed' });
  }
  return git.head(root);
};
