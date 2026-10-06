import { test, onTestFinished } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { collectChanges } from '../../src/main/review_diff.ts';

const run = promisify(execFile);

async function repo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskpilot-review-'));
  onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
  const g = (args) => run('git', args, { cwd: root });
  await g(['init', '-b', 'main', '-q']);
  await g(['config', 'user.email', 'test@example.com']);
  await g(['config', 'user.name', 'Test']);
  await fs.writeFile(path.join(root, 'a.js'), 'one\n');
  await g(['add', '.']);
  await g(['commit', '-qm', 'init']);
  const baseline = (await g(['rev-parse', 'HEAD'])).stdout.trim();
  const write = async (file, content) => {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), content);
  };
  return { root, baseline, write };
}

test('collects tracked and untracked changes, skipping secrets and binaries', async () => {
  const { root, baseline, write } = await repo();
  await write('a.js', 'two\n');
  await write('src/new/b.js', 'new file\n');
  await write('.env', 'TOKEN=hunter2\n');
  await write('img.png', Buffer.from([0, 1, 2, 0, 255]));

  const { files, skipped } = await collectChanges(root, baseline);
  const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
  assert.match(byPath['a.js'].patch, /\+two/);
  assert.equal(byPath['src/new/b.js'].untracked, true);
  assert.match(byPath['src/new/b.js'].patch, /\+new file/);
  assert.deepEqual(skipped.sort((x, y) => x.path.localeCompare(y.path)), [
    { path: '.env', reason: 'secret' },
    { path: 'img.png', reason: 'binary' },
  ]);
  // The secret's contents never appear anywhere in the result.
  assert.doesNotMatch(JSON.stringify(files), /hunter2/);
});

test('reads prioritized files first and enforces size limits', async () => {
  const { root, baseline, write } = await repo();
  await write('a.js', 'two\n');
  await write('big.js', 'x'.repeat(5000));
  await write('z-scope.js', 'in scope\n');

  const { files, skipped } = await collectChanges(root, baseline, {
    limits: { maxPatchBytes: 1000 },
    prioritize: (p) => p === 'z-scope.js',
  });
  assert.deepEqual(files.map((f) => f.path), ['z-scope.js', 'a.js']);
  assert.deepEqual(skipped, [{ path: 'big.js', reason: 'too_large' }]);

  // The file limit keeps the prioritized file.
  const capped = await collectChanges(root, baseline, { limits: { maxFiles: 1 }, prioritize: (p) => p === 'z-scope.js' });
  assert.deepEqual(capped.files.map((f) => f.path), ['z-scope.js']);
  assert.deepEqual(capped.skipped.map((s) => s.reason), ['file_limit', 'file_limit']);

  const budget = await collectChanges(root, baseline, { limits: { maxTotalBytes: 400 } });
  assert.deepEqual(budget.skipped, [{ path: 'big.js', reason: 'budget' }]);
});
