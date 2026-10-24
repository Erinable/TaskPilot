import { onTestFinished, test } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const SCRIPT = path.resolve('scripts/check_electron.sh');

// A repository copy holding only the script and an electron package.
const fakeRepo = async (electron: Record<string, string> | null) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskpilot-electron-'));
  onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'scripts'));
  await fs.copyFile(SCRIPT, path.join(root, 'scripts/check_electron.sh'));
  for (const [file, content] of Object.entries(electron ?? {})) {
    await fs.mkdir(path.dirname(path.join(root, 'node_modules/electron', file)), { recursive: true });
    await fs.writeFile(path.join(root, 'node_modules/electron', file), content);
  }
  return spawnSync('bash', [path.join(root, 'scripts/check_electron.sh')], { encoding: 'utf8' });
};

test('check_electron passes when the binary path.txt names exists', async () => {
  const result = await fakeRepo({ 'path.txt': 'Electron.app/Contents/MacOS/Electron', 'dist/Electron.app/Contents/MacOS/Electron': '' });
  assert.equal(result.status, 0, result.stderr);
});

test('check_electron explains a missing binary and a missing package', async () => {
  for (const files of [{ 'index.js': '' }, { 'path.txt': 'Electron.app/Contents/MacOS/Electron' }]) {
    const result = await fakeRepo(files);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /npm rebuild electron/);
  }
  const absent = await fakeRepo(null);
  assert.equal(absent.status, 1);
  assert.match(absent.stderr, /run npm install/);
});
