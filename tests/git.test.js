const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const git = require('../src/git');

const run = promisify(execFile);

// A real repository is used rather than a mock: the point of these tests is
// that the porcelain parsing matches what git actually emits.
async function makeRepo() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'taskpilot-git-'));
  test.after(() => fs.rm(dir, { recursive: true, force: true }));
  const g = (args) => run('git', args, { cwd: dir });
  await g(['init', '-b', 'main', '-q']);
  await g(['config', 'user.email', 'test@example.com']);
  await g(['config', 'user.name', 'Test']);
  await fs.writeFile(path.join(dir, 'a.txt'), 'one\ntwo\n');
  await g(['add', 'a.txt']);
  await g(['commit', '-qm', 'init']);
  return { dir, g };
}

test('isRepo() distinguishes a repository from a plain directory', async () => {
  const { dir } = await makeRepo();
  assert.equal(await git.isRepo(dir), true);
  const plain = await fs.mkdtemp(path.join(os.tmpdir(), 'taskpilot-plain-'));
  test.after(() => fs.rm(plain, { recursive: true, force: true }));
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
  await g(['add', 'c.txt']);

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

  assert.deepEqual((await git.diffStat(dir, baseline)).map((c) => c.path), ['a.txt']);

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
  await g(['add', 'staged.txt']);
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
  await assert.rejects(() => git.diffFile(dir, 'nonexistent-ref', 'a.txt'), (error) => {
    assert.equal(error.name, 'GitError');
    assert.equal(error.code, 'git_failed');
    assert.ok(error.stderr.length > 0);
    return true;
  });
});
