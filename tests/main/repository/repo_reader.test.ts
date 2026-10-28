/** @module-tag integration */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tempDir } from '../../fixtures/temp_dir.ts';
import { gitRepo } from '../../fixtures/git_repo.ts';
import { readTracked, looksSecret } from '../../../src/main/repository/repo_reader.ts';
import { listFiles } from '../../../src/main/repository/git.ts';

const repo = async (files: Record<string, string | Buffer>, { untracked = {} as Record<string, string>, symlinks = {} as Record<string, string> } = {}) => {
  const prepare = async (root: string) => {
    for (const [link, target] of Object.entries(symlinks)) await fs.symlink(target, path.join(root, link));
  };
  return (await gitRepo(files, { prefix: 'taskpilot-reader-', untracked, prepare })).root;
};

const reasons = (result) => Object.fromEntries(result.skipped.map((s) => [s.path, s.reason]));

test('reads tracked text files in the requested order', async () => {
  const root = await repo({ 'src/a.ts': 'export const a = 1;\n', 'src/b.ts': 'export const b = 2;\n' });
  const { files, skipped } = await readTracked(root, ['src/b.ts', 'src/a.ts', 'src/b.ts']);
  assert.deepEqual(
    files.map((f) => f.path),
    ['src/b.ts', 'src/a.ts'],
  );
  assert.equal(files[1].content, 'export const a = 1;\n');
  assert.match(files[0].sha, /^[0-9a-f]{40}$/);
  assert.deepEqual(skipped, []);
});

test('refuses untracked, outside, and absolute paths', async () => {
  const root = await repo({ 'src/a.ts': 'x' }, { untracked: { 'local.ts': 'not committed' } });
  const result = await readTracked(root, ['local.ts', '../etc/passwd', '/etc/passwd', 'src/../src/a.ts']);
  assert.deepEqual(result.files, []);
  assert.deepEqual(Object.values(reasons(result)), ['not_tracked', 'not_tracked', 'not_tracked', 'not_tracked']);
});

test('a tracked symlink is not followed, even when it points outside the repo', async () => {
  const outside = await tempDir('taskpilot-outside-');
  await fs.writeFile(path.join(outside, 'secret.txt'), 'TOP SECRET');
  const root = await repo({ 'src/a.ts': 'x' }, { symlinks: { 'link.txt': path.join(outside, 'secret.txt') } });
  const result = await readTracked(root, ['link.txt']);
  assert.deepEqual(result.files, []);
  assert.equal(reasons(result)['link.txt'], 'not_a_file');
});

test('reads the committed blob, not later edits on disk', async () => {
  // Contents come from the index, so an uncommitted change (or a file swapped
  // for a symlink after staging) is never what the agent sees.
  const root = await repo({ 'src/a.ts': 'committed\n' });
  await fs.writeFile(path.join(root, 'src/a.ts'), 'edited on disk\n');
  const { files } = await readTracked(root, ['src/a.ts']);
  assert.equal(files[0].content, 'committed\n');
});

test('refuses tracked files that commonly hold secrets', async () => {
  const root = await repo({
    '.env': 'KEY=1',
    'config/.env.production': 'KEY=2',
    'deploy/server.pem': 'x',
    id_ed25519: 'x',
    'config/secrets.json': '{}',
    'src/credentials.ts': 'x',
    '.npmrc': 'x',
    'src/app.ts': 'ok',
  });
  const result = await readTracked(root, [
    '.env',
    'config/.env.production',
    'deploy/server.pem',
    'id_ed25519',
    'config/secrets.json',
    'src/credentials.ts',
    '.npmrc',
    'src/app.ts',
  ]);
  assert.deepEqual(
    result.files.map((f) => f.path),
    ['src/app.ts'],
  );
  assert.ok(Object.values(reasons(result)).every((reason) => reason === 'secret'));
});

test('git.listFiles() leaves secret-looking paths out of the list agents see', async () => {
  // Regression: a committed .env was never read, but its name still reached
  // agents in the file list.
  const root = await repo({ '.env': 'KEY=1', 'deploy/server.pem': 'x', 'src/app.ts': 'ok' });
  assert.deepEqual(await listFiles(root), ['src/app.ts']);
});

test('looksSecret() does not flag ordinary names that merely contain the words', () => {
  assert.equal(looksSecret('src/environment.ts'), false);
  assert.equal(looksSecret('docs/keyboard.md'), false);
  assert.equal(looksSecret('src/secretary.ts'), false);
  // A keyword as a whole name segment is refused, even when harmless:
  // conservative by design, and reported as skipped so it stays visible.
  assert.equal(looksSecret('src/auth/password-hasher.ts'), true);
});

test('enforces binary, per-file, count, and total limits', async () => {
  const root = await repo({
    'img.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1]),
    'big.ts': 'x'.repeat(300),
    'a.ts': 'a'.repeat(100),
    'b.ts': 'b'.repeat(100),
    'c.ts': 'c'.repeat(100),
    'd.ts': 'd',
  });
  const result = await readTracked(root, ['img.png', 'big.ts', 'a.ts', 'b.ts', 'c.ts', 'd.ts'], { maxFileBytes: 200, maxTotalBytes: 250, maxFiles: 3 });
  assert.deepEqual(
    result.files.map((f) => f.path),
    ['a.ts', 'b.ts', 'd.ts'],
  );
  assert.deepEqual(reasons(result), { 'img.png': 'binary', 'big.ts': 'too_large', 'c.ts': 'budget' });
});
