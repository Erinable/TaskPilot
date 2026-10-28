// Opens a workspace file for the developer to edit: in VS Code at a line when
// its `code` command is on PATH, otherwise in the OS text editor, otherwise
// shown in the file manager.
//
// SECURITY: the path comes from the renderer, and may come from model text (a
// QA issue). It must resolve inside the workspace root after symlinks, and the
// file is never handed to the OS "open" handler, which would run a script or
// launch an app bundle. Programs are started with execFile and an argument
// array, never a shell string.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import type { ErrorCode } from '../../shared/error_codes.ts';
import { isInside, resolveExecutable } from './workspace.ts';
import type { OpenedWith } from '../../shared/ipc/workspace.ts';

const execFileAsync = promisify(execFile);

export const MAX_LINE = 1_000_000;

export type OpenFileDeps = {
  envPath?: string;
  platform?: NodeJS.Platform;
  // Starts a program; resolves once it has handed the file over.
  launch?: (file: string, args: string[]) => Promise<void>;
  // Shows the file in the OS file manager (Electron's shell.showItemInFolder).
  reveal: (file: string) => void;
};

const openError = (message: string, code: ErrorCode) => Object.assign(new Error(message), { code });

export const openWorkspaceFile = async (
  root: string,
  relative: string,
  line: number | null,
  { envPath, platform = process.platform, launch = async (file, args) => void (await execFileAsync(file, args)), reveal }: OpenFileDeps,
): Promise<OpenedWith> => {
  if (!isInside(root, relative)) throw openError(`Path is outside the workspace: ${relative}`, 'path_outside_workspace');
  if (line !== null && (!Number.isInteger(line) || line < 1 || line > MAX_LINE)) throw openError('Line must be a positive whole number', 'invalid_line');

  const absolute = path.resolve(root, relative);
  let real: string;
  try {
    const stat = await fs.stat(absolute);
    if (!stat.isFile()) throw openError(`Not a file: ${relative}`, 'not_a_file');
    real = await fs.realpath(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw openError(`File does not exist yet: ${relative}`, 'file_missing');
    throw error;
  }
  // A symlink inside the repository could point anywhere on disk.
  if (!isInside(await fs.realpath(root), path.relative(await fs.realpath(root), real))) {
    throw openError(`Path is outside the workspace: ${relative}`, 'path_outside_workspace');
  }

  // On Windows `code` is a .cmd script, which execFile can only run through a shell.
  const code = platform === 'win32' ? null : await resolveExecutable('code', { envPath, platform });
  if (code) {
    // An absolute path never starts with "-", so it cannot be read as a flag.
    await launch(code, line ? ['--goto', `${real}:${line}`] : [real]);
    return 'vscode';
  }
  // macOS: `open -t` uses the default text editor, never the file's own handler.
  if (platform === 'darwin') {
    await launch('/usr/bin/open', ['-t', real]);
    return 'text_editor';
  }
  reveal(real);
  return 'folder';
};
