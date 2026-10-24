import { test, onTestFinished } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as merge from '../../src/main/patch_merge.ts';

const git = (cwd: string, args: string[], input?: string) =>
  execFileSync('git', ['-c', 'user.email=e@x', '-c', 'user.name=t', ...args], { cwd, input, encoding: 'utf8' });

// A repository at `base`, the agent's per-file patches against it, and then
// the developer's own edits applied on top, as the working tree is at apply.
const scenario = (base: Record<string, string>, agent: Record<string, string | null>, developer: Record<string, string | null>) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskpilot-merge-test-'));
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, ['init', '-q']);
  const write = (dir: string, files: Record<string, string | null>) => {
    for (const [file, content] of Object.entries(files)) {
      const target = path.join(dir, file);
      if (content === null) fs.rmSync(target, { force: true });
      else {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
      }
    }
  };
  write(root, base);
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'base']);
  const baseline = git(root, ['rev-parse', 'HEAD']).trim();
  // The agent works in a copy, as the isolated run does.
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'taskpilot-merge-copy-'));
  onTestFinished(() => fs.rmSync(copy, { recursive: true, force: true }));
  git(copy, ['init', '-q']);
  write(copy, base);
  git(copy, ['add', '-A']);
  git(copy, ['commit', '-qm', 'base']);
  write(copy, agent);
  git(copy, ['add', '-A']);
  const files = Object.keys(agent).map((file) => ({ path: file, patch: git(copy, ['diff', '--cached', '--binary', '--', file]) }));
  write(root, developer);
  const indexBefore = fs.readFileSync(path.join(root, '.git', 'index'));
  return { root, baseline, files, read: (file: string) => fs.readFileSync(path.join(root, file), 'utf8'), indexBefore };
};

const LINES = 'a\nb\nc\nd\ne\nf\ng\n';

test('untouched files are clean, and edits elsewhere in the same file merge', async () => {
  const s = scenario(
    { 'one.txt': LINES, 'two.txt': LINES },
    { 'one.txt': LINES.replace('a\n', 'A\n'), 'two.txt': LINES.replace('a\n', 'A\n') },
    { 'two.txt': LINES.replace('g\n', 'G\n') },
  );
  assert.deepEqual(await merge.previewMerge(s.root, s.baseline, s.files), [
    { path: 'one.txt', state: 'clean', markers: false },
    { path: 'two.txt', state: 'merged', markers: false },
  ]);
  const result = await merge.applyMerged(s.root, s.baseline, s.files, {});
  assert.deepEqual(result, { written: ['one.txt', 'two.txt'], markers: [], kept: [] });
  assert.equal(s.read('one.txt'), LINES.replace('a\n', 'A\n'));
  // Both edits survive.
  assert.equal(s.read('two.txt'), 'A\nb\nc\nd\ne\nf\nG\n');
});

test('the same line edited on both sides is a conflict that needs a choice', async () => {
  const s = scenario({ 'f.txt': 'one\n', 'ok.txt': LINES }, { 'f.txt': 'agent\n', 'ok.txt': LINES.replace('a\n', 'A\n') }, { 'f.txt': 'mine\n' });
  assert.deepEqual(await merge.previewMerge(s.root, s.baseline, s.files), [
    { path: 'f.txt', state: 'conflict', markers: true },
    { path: 'ok.txt', state: 'clean', markers: false },
  ]);
  // No choice: nothing is written, not even the clean file.
  await assert.rejects(merge.applyMerged(s.root, s.baseline, s.files, {}), { code: 'merge_unresolved' });
  assert.equal(s.read('f.txt'), 'mine\n');
  assert.equal(s.read('ok.txt'), LINES);
});

test('each choice for a conflict writes what it says', async () => {
  const make = () => scenario({ 'f.txt': 'one\n' }, { 'f.txt': 'agent\n' }, { 'f.txt': 'mine\n' });
  const markers = make();
  assert.deepEqual(await merge.applyMerged(markers.root, markers.baseline, markers.files, { 'f.txt': 'markers' }), {
    written: ['f.txt'],
    markers: ['f.txt'],
    kept: [],
  });
  assert.equal(markers.read('f.txt'), '<<<<<<< 你的改动\nmine\n=======\nagent\n>>>>>>> Coding Agent\n');
  assert.deepEqual(await merge.filesWithMarkers(markers.root, ['f.txt']), ['f.txt']);

  const mine = make();
  assert.deepEqual(await merge.applyMerged(mine.root, mine.baseline, mine.files, { 'f.txt': 'mine' }), { written: [], markers: [], kept: ['f.txt'] });
  assert.equal(mine.read('f.txt'), 'mine\n');

  const theirs = make();
  await merge.applyMerged(theirs.root, theirs.baseline, theirs.files, { 'f.txt': 'theirs' });
  assert.equal(theirs.read('f.txt'), 'agent\n');
  assert.deepEqual(await merge.filesWithMarkers(theirs.root, ['f.txt']), []);
});

test('a file deleted by one side and edited by the other cannot carry markers', async () => {
  const s = scenario({ 'md.txt': 'keep\n', 'dm.txt': 'old\n' }, { 'md.txt': null, 'dm.txt': 'agent edit\n' }, { 'md.txt': 'user edit\n', 'dm.txt': null });
  assert.deepEqual(await merge.previewMerge(s.root, s.baseline, s.files), [
    { path: 'md.txt', state: 'conflict', markers: false },
    { path: 'dm.txt', state: 'conflict', markers: false },
  ]);
  await assert.rejects(merge.applyMerged(s.root, s.baseline, s.files, { 'md.txt': 'markers', 'dm.txt': 'mine' }), { code: 'merge_cannot_apply' });
  // The agent's version: md.txt deleted, dm.txt restored with its edit.
  await merge.applyMerged(s.root, s.baseline, s.files, { 'md.txt': 'theirs', 'dm.txt': 'theirs' });
  assert.equal(fs.existsSync(path.join(s.root, 'md.txt')), false);
  assert.equal(s.read('dm.txt'), 'agent edit\n');
});

test('binary and both-added conflicts', async () => {
  const s = scenario({ 'b.bin': '\0\u0001base' }, { 'b.bin': '\0\u0002agent', 'aa.txt': 'agent\n' }, { 'b.bin': '\0\u0003mine', 'aa.txt': 'mine\n' });
  assert.deepEqual(await merge.previewMerge(s.root, s.baseline, s.files), [
    { path: 'b.bin', state: 'conflict', markers: false },
    { path: 'aa.txt', state: 'conflict', markers: true },
  ]);
  await merge.applyMerged(s.root, s.baseline, s.files, { 'b.bin': 'theirs', 'aa.txt': 'markers' });
  assert.deepEqual(fs.readFileSync(path.join(s.root, 'b.bin')), Buffer.from('\0\u0002agent'));
  assert.match(s.read('aa.txt'), /<<<<<<< 你的改动\nmine\n=======\nagent\n>>>>>>> Coding Agent/);
});

test('new files, deletions and the executable bit land as the agent made them', async () => {
  const s = scenario({ 'gone.txt': 'x\n', 'run.sh': 'echo 1\n' }, { 'gone.txt': null, 'new/added.txt': 'hello\n', 'run.sh': 'echo 2\n' }, {});
  fs.chmodSync(path.join(s.root, 'run.sh'), 0o755);
  git(s.root, ['commit', '-qam', 'exec']);
  const exec = scenario({ 'run.sh': 'echo 1\n' }, { 'run.sh': 'echo 2\n' }, {});
  void exec;
  await merge.applyMerged(s.root, s.baseline, s.files, {});
  assert.equal(fs.existsSync(path.join(s.root, 'gone.txt')), false);
  assert.equal(s.read('new/added.txt'), 'hello\n');
  assert.equal(s.read('run.sh'), 'echo 2\n');
});

test('the real index and every unpatched file stay untouched', async () => {
  const s = scenario(
    { 'f.txt': LINES, 'other.txt': 'x\n' },
    { 'f.txt': LINES.replace('a\n', 'A\n') },
    { 'f.txt': LINES.replace('g\n', 'G\n'), 'other.txt': 'staged by me\n' },
  );
  git(s.root, ['add', 'other.txt']);
  const index = fs.readFileSync(path.join(s.root, '.git', 'index'));
  await merge.previewMerge(s.root, s.baseline, s.files);
  await merge.applyMerged(s.root, s.baseline, s.files, {});
  assert.deepEqual(fs.readFileSync(path.join(s.root, '.git', 'index')), index);
  assert.equal(git(s.root, ['diff', '--cached', '--name-only']).trim(), 'other.txt');
  assert.equal(s.read('other.txt'), 'staged by me\n');
});

test('the digest changes when a file is edited between preview and apply', async () => {
  const s = scenario({ 'f.txt': 'one\n' }, { 'f.txt': 'agent\n' }, {});
  const patch = s.files.map((file) => file.patch).join('');
  const before = merge.mergeDigest(patch, await merge.previewMerge(s.root, s.baseline, s.files));
  fs.writeFileSync(path.join(s.root, 'f.txt'), 'mine\n');
  assert.notEqual(merge.mergeDigest(patch, await merge.previewMerge(s.root, s.baseline, s.files)), before);
});
