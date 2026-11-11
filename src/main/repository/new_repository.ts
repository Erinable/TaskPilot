// A new project from scratch: an empty folder the user picked becomes a git
// repository with a README and a .gitignore in its first commit, so a claim
// has a HEAD to measure its baseline against. The folder must be empty: files
// already there would be untracked, and QA would read all of them as changes.
import fs from 'node:fs/promises';
import path from 'node:path';

import { failWith } from '../infrastructure/coded_error.ts';
import * as git from './git.ts';
import * as gitCommit from './git_commit.ts';

export const GITIGNORE = '.DS_Store\n.env\n.env.*\n';

const readme = (name: string) => `# ${name}\n`;

// Absolute, an existing empty directory, and not inside a git repository.
export const checkFolder = async (root: string) => {
  if (!path.isAbsolute(root)) failWith('The folder must be an absolute path', 'root_not_absolute', 'root');
  const stat = await fs.stat(root).catch(() => failWith(`Directory not found: ${root}`, 'root_not_found', 'root'));
  if (!stat.isDirectory()) failWith(`Not a directory: ${root}`, 'root_not_found', 'root');
  if ((await fs.readdir(root)).length) failWith('Pick an empty folder for the new project', 'root_not_empty', 'root');
  if (await git.isRepo(root)) failWith('The folder is inside a git repository', 'root_in_repository', 'root');
};

// Starts the repository in `root`. A failure removes what was written, so the
// folder is empty again and can be retried (e.g. after setting a git identity).
export const createRepository = async (root: string) => {
  await checkFolder(root);
  const files: Record<string, string> = { 'README.md': readme(path.basename(root)), '.gitignore': GITIGNORE };
  try {
    for (const [file, content] of Object.entries(files)) await fs.writeFile(path.join(root, file), content, { flag: 'wx' });
    await gitCommit.initRepository(root);
    await gitCommit.commitFiles(root, Object.keys(files), 'chore: 初始化项目');
  } catch (error) {
    for (const name of ['.git', ...Object.keys(files)]) await fs.rm(path.join(root, name), { recursive: true, force: true });
    throw error;
  }
};
