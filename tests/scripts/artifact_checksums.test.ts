/** @module-tag integration */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';

import { tempDir } from '../fixtures/temp_dir.ts';

const execute = promisify(execFile);
const script = fileURLToPath(new URL('../../scripts/artifact_checksums.ts', import.meta.url));
const run = (directory: string) => execute(process.execPath, [script, directory]);
const emptyHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const abcHash = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

test('hashes package contents in filename order and ignores other build output', async () => {
  const directory = await tempDir('taskpilot-checksums-');
  await fs.writeFile(path.join(directory, 'Z package.zip'), 'abc');
  await fs.writeFile(path.join(directory, 'A.dmg'), '');
  await fs.writeFile(path.join(directory, 'builder-debug.yml'), 'not a package');
  await fs.mkdir(path.join(directory, 'mac-arm64'));
  await fs.writeFile(path.join(directory, 'mac-arm64', 'nested.zip'), 'not a top-level package');
  await run(directory);
  expect(await fs.readFile(path.join(directory, 'SHA256SUMS'), 'utf8')).toBe(`${emptyHash}  A.dmg\n${abcHash}  Z package.zip\n`);
});

test('regenerates the manifest after a package changes', async () => {
  const directory = await tempDir('taskpilot-checksums-');
  const file = path.join(directory, 'TaskPilot.zip');
  await fs.writeFile(file, 'abc');
  await run(directory);
  await fs.writeFile(file, '');
  await run(directory);
  expect(await fs.readFile(path.join(directory, 'SHA256SUMS'), 'utf8')).toBe(`${emptyHash}  TaskPilot.zip\n`);
  expect((await fs.readdir(directory)).sort()).toEqual(['SHA256SUMS', 'TaskPilot.zip']);
});

test('defaults to dist relative to the working directory', async () => {
  const cwd = await tempDir('taskpilot-checksums-default-');
  await fs.mkdir(path.join(cwd, 'dist'));
  await fs.writeFile(path.join(cwd, 'dist', 'TaskPilot.dmg'), 'abc');
  await execute(process.execPath, [script], { cwd });
  expect(await fs.readFile(path.join(cwd, 'dist', 'SHA256SUMS'), 'utf8')).toBe(`${abcHash}  TaskPilot.dmg\n`);
});

test('fails when there are no packages and preserves the previous manifest', async () => {
  const directory = await tempDir('taskpilot-checksums-empty-');
  await fs.writeFile(path.join(directory, 'SHA256SUMS'), 'previous manifest\n');
  await expect(run(directory)).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('No .dmg or .zip packages') });
  expect(await fs.readFile(path.join(directory, 'SHA256SUMS'), 'utf8')).toBe('previous manifest\n');
});

test('rejects symlinks and ambiguous names without replacing the previous manifest', async () => {
  for (const kind of ['symlink', 'newline', 'backslash'] as const) {
    const directory = await tempDir('taskpilot-checksums-unsafe-');
    await fs.writeFile(path.join(directory, 'SHA256SUMS'), 'previous manifest\n');
    if (kind === 'symlink') {
      await fs.writeFile(path.join(directory, 'target.txt'), 'abc');
      await fs.symlink('target.txt', path.join(directory, 'linked.zip'));
    } else {
      await fs.writeFile(path.join(directory, kind === 'newline' ? 'bad\nname.zip' : 'bad\\name.zip'), 'abc');
    }
    await expect(run(directory)).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Unsafe package file') });
    expect(await fs.readFile(path.join(directory, 'SHA256SUMS'), 'utf8')).toBe('previous manifest\n');
  }
});
