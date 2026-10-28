// A scratch git repository on branch main with an author set, removed when
// the test finishes. `files` are written (folders included) and committed as
// "init"; `untracked` are written after the commit. The root is the real path
// (macOS /var → /private/var), so it matches what git reports.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { tempDir } from './temp_dir.ts';

const execFileAsync = promisify(execFile);

export type GitRepoOptions = {
  prefix?: string;
  untracked?: Record<string, string>;
  // Runs before the first commit, for content that is copied rather than written.
  prepare?: (root: string) => Promise<void>;
};

export type GitRepo = {
  root: string;
  // Runs git in the repository and returns trimmed stdout.
  git: (...args: string[]) => Promise<string>;
  write: (files: Record<string, string | Buffer>) => Promise<void>;
  commit: (message: string) => Promise<string>;
  head: string;
};

export const gitRepo = async (
  files: Record<string, string | Buffer> = {},
  { prefix = 'taskpilot-repo-', untracked = {}, prepare }: GitRepoOptions = {},
): Promise<GitRepo> => {
  const root = await fs.realpath(await tempDir(prefix));
  const git = async (...args: string[]) => (await execFileAsync('git', args, { cwd: root })).stdout.trim();
  const write = async (entries: Record<string, string | Buffer>) => {
    for (const [file, content] of Object.entries(entries)) {
      await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await fs.writeFile(path.join(root, file), content);
    }
  };
  const commit = async (message: string) => {
    await git('add', '-A');
    await git('commit', '-qm', message);
    return git('rev-parse', 'HEAD');
  };
  await git('init', '-b', 'main', '-q');
  await git('config', 'user.email', 'test@example.com');
  await git('config', 'user.name', 'Test');
  await write(files);
  await prepare?.(root);
  const head = await commit('init');
  await write(untracked);
  return { root, git, write, commit, head };
};
