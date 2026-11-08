/** @module-tag integration */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tempDir } from '../../fixtures/temp_dir.ts';
import { gitRepo } from '../../fixtures/git_repo.ts';
import * as git from '../../../src/main/repository/git.ts';

// A real repository is used rather than a mock: the point of these tests is
// that the porcelain parsing matches what git actually emits.
const makeRepo = async () => {
  const { root: dir, git: g } = await gitRepo({ 'a.txt': 'one\ntwo\n' }, { prefix: 'taskpilot-git-' });
  return { dir, g };
};

test('isRepo() distinguishes a repository from a plain directory', async () => {
  const { dir } = await makeRepo();
  assert.equal(await git.isRepo(dir), true);
  const plain = await tempDir('taskpilot-plain-');
  assert.equal(await git.isRepo(plain), false);
});

test('topLevel() resolves a subdirectory to the repository root', async () => {
  const { dir } = await makeRepo();
  await fs.mkdir(path.join(dir, 'nested', 'deeper'), { recursive: true });
  const top = await git.topLevel(path.join(dir, 'nested', 'deeper'));
  assert.equal(await fs.realpath(top), await fs.realpath(dir));
});

test('describe() reports branch, commit, and a clean tree', async () => {
  const { dir } = await makeRepo();
  const info = await git.describe(dir);
  assert.equal(info.branch, 'main');
  assert.match(info.commit, /^[0-9a-f]{40}$/);
  assert.equal(info.dirty, false);
  assert.equal(info.changedFiles, 0);
});

test('status() reports staged, unstaged, and untracked files', async () => {
  const { dir, g } = await makeRepo();
  await fs.writeFile(path.join(dir, 'a.txt'), 'one\ntwo\nthree\n');
  await fs.writeFile(path.join(dir, 'b.txt'), 'new\n');
  await fs.writeFile(path.join(dir, 'c.txt'), 'staged\n');
  await g('add', 'c.txt');

  const byPath = Object.fromEntries((await git.status(dir)).map((e) => [e.path, e]));
  assert.equal(byPath['a.txt'].staged, false);
  assert.equal(byPath['b.txt'].untracked, true);
  assert.equal(byPath['c.txt'].staged, true);
  assert.equal((await git.describe(dir)).dirty, true);
});

test('status() handles paths containing spaces', async () => {
  const { dir } = await makeRepo();
  await fs.writeFile(path.join(dir, 'two words.txt'), 'x\n');
  const paths = (await git.status(dir)).map((e) => e.path);
  assert.ok(paths.includes('two words.txt'), paths.join());
});

test('parseStatus() pairs a rename with its source path', () => {
  const entries = git.parseStatus('R  new.txt\0old.txt\0 M other.txt\0');
  assert.equal(entries.length, 2);
  assert.equal(entries[0].path, 'old.txt → new.txt');
  assert.equal(entries[1].path, 'other.txt');
});

test('diffStat() counts worktree changes against a baseline commit', async () => {
  const { dir } = await makeRepo();
  const baseline = await git.head(dir);
  await fs.writeFile(path.join(dir, 'a.txt'), 'one\ntwo\nthree\n');
  const [entry] = await git.diffStat(dir, baseline);
  assert.equal(entry.path, 'a.txt');
  assert.equal(entry.added, 1);
  assert.equal(entry.removed, 0);
  assert.equal(entry.binary, false);
});

test('diffFile() returns a unified diff for one file', async () => {
  const { dir } = await makeRepo();
  const baseline = await git.head(dir);
  await fs.writeFile(path.join(dir, 'a.txt'), 'one\nchanged\n');
  const diff = await git.diffFile(dir, baseline, 'a.txt');
  assert.match(diff, /^--- a\/a\.txt$/m);
  assert.match(diff, /^\+changed$/m);
  assert.match(diff, /^-two$/m);
});

test('changesSince() includes untracked files that git diff omits', async () => {
  // A new file outside the work package scope is the most common shape an
  // out-of-scope change takes, and `git diff` never reports it.
  const { dir } = await makeRepo();
  const baseline = await git.head(dir);
  await fs.writeFile(path.join(dir, 'a.txt'), 'one\ntwo\nthree\n');
  await fs.writeFile(path.join(dir, 'rogue.ts'), 'export const a = 1;\nexport const b = 2;\n');

  assert.deepEqual(
    (await git.diffStat(dir, baseline)).map((c) => c.path),
    ['a.txt'],
  );

  const changes = await git.changesSince(dir, baseline);
  const byPath = Object.fromEntries(changes.map((c) => [c.path, c]));
  assert.deepEqual(Object.keys(byPath).sort(), ['a.txt', 'rogue.ts']);
  assert.equal(byPath['rogue.ts'].untracked, true);
  assert.equal(byPath['rogue.ts'].added, 2);
  assert.equal(byPath['a.txt'].untracked, false);
});

test('changesSince() lists each file in a new untracked directory', async () => {
  // git status collapses an untracked directory to "dir/" by default, which
  // no file scope matches and which hid the new files from QA.
  const { dir } = await makeRepo();
  const baseline = await git.head(dir);
  await fs.mkdir(path.join(dir, 'src/new'), { recursive: true });
  await fs.writeFile(path.join(dir, 'src/new/a.ts'), 'export {};\n');
  await fs.writeFile(path.join(dir, 'src/new/b.ts'), 'export {};\n');
  const paths = (await git.changesSince(dir, baseline)).map((c) => c.path).sort();
  assert.deepEqual(paths, ['src/new/a.ts', 'src/new/b.ts']);
});

test('changesSince() does not double-count a staged new file', async () => {
  const { dir, g } = await makeRepo();
  const baseline = await git.head(dir);
  await fs.writeFile(path.join(dir, 'staged.txt'), 'x\n');
  await g('add', 'staged.txt');
  const paths = (await git.changesSince(dir, baseline)).map((c) => c.path);
  assert.deepEqual(paths, ['staged.txt']);
});

test('changesSince() flags an untracked binary file without counting lines', async () => {
  const { dir } = await makeRepo();
  const baseline = await git.head(dir);
  await fs.writeFile(path.join(dir, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02]));
  const [change] = (await git.changesSince(dir, baseline)).filter((c) => c.path === 'blob.bin');
  assert.equal(change.binary, true);
  assert.equal(change.added, 0);
});

test('diffFile() shows the contents of an untracked file', async () => {
  const { dir } = await makeRepo();
  const baseline = await git.head(dir);
  await fs.writeFile(path.join(dir, 'fresh.ts'), 'export const fresh = true;\n');
  const diff = await git.diffFile(dir, baseline, 'fresh.ts');
  assert.match(diff, /^\+export const fresh = true;$/m);
});

test('git errors surface a code and stderr instead of a raw exec failure', async () => {
  const { dir } = await makeRepo();
  await assert.rejects(
    () => git.diffFile(dir, 'nonexistent-ref', 'a.txt'),
    (error) => {
      assert.ok(error instanceof git.GitError);
      assert.equal(error.code, 'git_failed');
      assert.ok(error.stderr, 'stderr is kept and non-empty');
      return true;
    },
  );
});

test('changesSince() never opens a FIFO or a symlink to a device and does not read a file past the cap', async () => {
  const { dir } = await makeRepo();
  const baseline = await git.head(dir);
  // Reading either would block or never end.
  execFileSync('mkfifo', [path.join(dir, 'pipe')]);
  await fs.symlink('/dev/zero', path.join(dir, 'zero'));
  await fs.writeFile(path.join(dir, 'huge.txt'), 'line\n'.repeat(Math.ceil(git.MAX_COUNTED_BYTES / 5) + 1));
  await fs.writeFile(path.join(dir, 'small.txt'), 'a\nb\n');
  const byPath = Object.fromEntries((await git.changesSince(dir, baseline)).map((change) => [change.path, change]));
  assert.deepEqual([byPath.zero.added, byPath.zero.binary, byPath.zero.tooLarge], [0, false, undefined]);
  assert.deepEqual([byPath['huge.txt'].added, byPath['huge.txt'].tooLarge], [0, true]);
  assert.equal(byPath['small.txt'].added, 2);
  // git status leaves FIFOs out; if it ever lists one, it must not be read.
  if (byPath.pipe) assert.equal(byPath.pipe.added, 0);
});

test('changesSince() counts many untracked files and keeps git status order', async () => {
  const { dir } = await makeRepo();
  const baseline = await git.head(dir);
  const names = Array.from({ length: 30 }, (_unused, index) => `n${String(index).padStart(2, '0')}.txt`);
  for (const [index, name] of names.entries()) await fs.writeFile(path.join(dir, name), 'x\n'.repeat(index + 1));
  const untracked = (await git.changesSince(dir, baseline)).filter((change) => change.untracked);
  assert.deepEqual(
    untracked.map((change) => change.path),
    names,
  );
  assert.deepEqual(
    untracked.map((change) => change.added),
    names.map((_name, index) => index + 1),
  );
});
