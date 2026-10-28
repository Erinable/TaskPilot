import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { tempDir } from '../../fixtures/temp_dir.ts';
import { openWorkspaceFile } from '../../../src/main/repository/open_file.ts';

// A workspace with src/app.ts, a bin dir holding a fake `code`, and a file outside it.
const setup = async () => {
  const base = await fs.realpath(await tempDir('taskpilot-open-'));
  const root = path.join(base, 'repo');
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src/app.ts'), 'export {};\n');
  await fs.writeFile(path.join(base, 'secret.txt'), 'outside\n');
  const bin = path.join(base, 'bin');
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, 'code'), '#!/bin/sh\n', { mode: 0o755 });
  const launched: { file: string; args: string[] }[] = [];
  const revealed: string[] = [];
  const deps = (envPath: string, platform: NodeJS.Platform = 'darwin') => ({
    envPath,
    platform,
    launch: async (file: string, args: string[]) => void launched.push({ file, args }),
    reveal: (file: string) => void revealed.push(file),
  });
  return { base, root, bin, launched, revealed, deps };
};

test('opens in VS Code at the line when `code` is on PATH', async () => {
  const { root, bin, launched, deps } = await setup();
  assert.equal(await openWorkspaceFile(root, 'src/app.ts', 12, deps(bin)), 'vscode');
  assert.deepEqual(launched, [{ file: path.join(bin, 'code'), args: ['--goto', `${path.join(root, 'src/app.ts')}:12`] }]);
  await openWorkspaceFile(root, './src/app.ts', null, deps(bin));
  assert.deepEqual(launched[1].args, [path.join(root, 'src/app.ts')]);
});

test('without `code`, macOS uses the text editor and other systems show the folder', async () => {
  const { base, root, launched, revealed, deps } = await setup();
  const empty = path.join(base, 'nothing');
  assert.equal(await openWorkspaceFile(root, 'src/app.ts', 3, deps(empty, 'darwin')), 'text_editor');
  // Never the file's own handler: `-t` forces a text editor.
  assert.deepEqual(launched, [{ file: '/usr/bin/open', args: ['-t', path.join(root, 'src/app.ts')] }]);
  assert.equal(await openWorkspaceFile(root, 'src/app.ts', null, deps(empty, 'linux')), 'folder');
  assert.deepEqual(revealed, [path.join(root, 'src/app.ts')]);
});

test('Windows never runs code.cmd, which needs a shell', async () => {
  const { root, bin, launched, revealed, deps } = await setup();
  assert.equal(await openWorkspaceFile(root, 'src/app.ts', 1, deps(bin, 'win32')), 'folder');
  assert.deepEqual(launched, []);
  assert.equal(revealed.length, 1);
});

test('refuses paths outside the workspace, including through a symlink', async () => {
  const { base, root, bin, launched, deps } = await setup();
  await fs.symlink(path.join(base, 'secret.txt'), path.join(root, 'link.txt'));
  for (const candidate of ['../secret.txt', path.join(base, 'secret.txt'), 'link.txt', '']) {
    await assert.rejects(openWorkspaceFile(root, candidate, null, deps(bin)), { code: 'path_outside_workspace' }, candidate);
  }
  assert.deepEqual(launched, []);
});

test('explains a missing file, a directory and a bad line', async () => {
  const { root, bin, deps } = await setup();
  await assert.rejects(openWorkspaceFile(root, 'src/new.ts', null, deps(bin)), { code: 'file_missing' });
  await assert.rejects(openWorkspaceFile(root, 'src', null, deps(bin)), { code: 'not_a_file' });
  for (const line of [0, -1, 1.5, Number.NaN, 2_000_000]) {
    await assert.rejects(openWorkspaceFile(root, 'src/app.ts', line, deps(bin)), { code: 'invalid_line' }, String(line));
  }
});
