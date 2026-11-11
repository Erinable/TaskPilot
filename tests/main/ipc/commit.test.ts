/** @module-tag integration */
// IPC channels of the commit domain (src/main/ipc/commit.ts).
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { CHANNELS } from '../../../src/shared/ipc_channels.ts';
import * as fixtures from './harness.ts';
import { SAMPLE_TASKS } from '../fixtures/sample_tasks.ts';

/* Committing a finished package */

const doneState = { status: 'done', baseline: null, claimedAt: null, completedSteps: [], deviations: [], review: null };

const commitHarness = async () => {
  const h = await fixtures.harness({ seedState: { 'auth-edge-tests': doneState } });
  const g = (args: string[]) => fixtures.run('git', args, { cwd: h.root });
  await fs.mkdir(path.join(h.root, 'tests/auth'), { recursive: true });
  await fs.writeFile(path.join(h.root, 'tests/auth/login-user.test.ts'), 'test("x", () => {});\n');
  // Out of scope, and a secret-looking file: both held back.
  await fs.writeFile(path.join(h.root, 'notes.md'), 'scratch\n');
  await fs.writeFile(path.join(h.root, '.env'), 'TOKEN=x\n');
  return { ...h, g };
};

test('commit: the preview lists scope files, holds back the rest and suggests a message', async () => {
  const { call } = await commitHarness();
  const { data } = await call(CHANNELS.commitPreview, 'auth-edge-tests');
  assert.deepEqual(data.files, ['tests/auth/login-user.test.ts']);
  assert.deepEqual(data.skipped.map((item) => [item.path, item.reason]).sort(), [
    ['.env', 'secret'],
    ['notes.md', 'out_of_scope'],
  ]);
  assert.equal(data.message.split('\n')[0], '补充登录模块边界测试');
});

test('commit: commits only the reviewed scope files, never pushes, keeps other changes', async () => {
  const { call, g } = await commitHarness();
  // Something the developer staged themselves stays staged and out of this commit.
  await fs.writeFile(path.join((await call(CHANNELS.workspaceInfo)).data.root, 'staged.txt'), 'mine\n');
  await g(['add', 'staged.txt']);

  const result = await call(CHANNELS.commitCreate, 'auth-edge-tests', '补充登录边界测试\n\n详情', ['tests/auth/login-user.test.ts']);
  assert.equal(result.ok, true, JSON.stringify(result.error));
  const { stdout: files } = await g(['show', '--name-only', '--format=%s', 'HEAD']);
  assert.deepEqual(files.trim().split('\n'), ['补充登录边界测试', '', 'tests/auth/login-user.test.ts']);
  const { stdout: status } = await g(['status', '--porcelain']);
  assert.match(status, /^A {2}staged\.txt$/m);
  assert.match(status, /^\?\? notes\.md$/m);
  assert.match(status, /^\?\? \.env$/m);
  // Nothing left to commit for the package.
  assert.deepEqual((await call(CHANNELS.commitPreview, 'auth-edge-tests')).data.files, []);
});

test('commit: a list that changed since the developer looked commits nothing', async () => {
  const { call, g } = await commitHarness();
  const before = (await g(['rev-parse', 'HEAD'])).stdout;
  const response = await call(CHANNELS.commitCreate, 'auth-edge-tests', 'x', ['tests/auth/other.test.ts']);
  assert.equal(response.error.code, 'changes_changed');
  assert.equal((await g(['rev-parse', 'HEAD'])).stdout, before);
});

test('commit: refuses a package that is not accepted yet, and an empty message', async () => {
  const { call } = await fixtures.harness();
  assert.equal((await call(CHANNELS.commitPreview, 'auth-edge-tests')).error.code, 'invalid_state');
  const { call: callDone } = await commitHarness();
  assert.equal((await callDone(CHANNELS.commitCreate, 'auth-edge-tests', '  \n', ['tests/auth/login-user.test.ts'])).error.code, 'invalid_message');
});

test('commit: a package waiting for acceptance cannot be committed yet', async () => {
  const { call } = await fixtures.harness({ seedState: { 'auth-edge-tests': { ...doneState, status: 'accepting' } } });
  assert.equal((await call(CHANNELS.commitPreview, 'auth-edge-tests')).error.code, 'invalid_state');
});

test('commit: an uncommitted taskpilot.toml is offered with the package, and only committed when ticked', async () => {
  const { call, g, root } = await commitHarness();
  await fs.writeFile(path.join(root, 'taskpilot.toml'), 'preset = "typescript"\n');
  const { data } = await call(CHANNELS.commitPreview, 'auth-edge-tests');
  assert.deepEqual(data.optional, ['taskpilot.toml']);
  assert.ok(!data.skipped.some((item) => item.path === 'taskpilot.toml'));
  // Another file passed as optional is refused: only offered ones can be added.
  assert.equal((await call(CHANNELS.commitCreate, 'auth-edge-tests', 'x', data.files, ['notes.md'])).error.code, 'changes_changed');

  const result = await call(CHANNELS.commitCreate, 'auth-edge-tests', '补充登录边界测试', data.files, ['taskpilot.toml']);
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.deepEqual(result.data.files, ['tests/auth/login-user.test.ts', 'taskpilot.toml']);
  const { stdout } = await g(['show', '--name-only', '--format=', 'HEAD']);
  assert.deepEqual(stdout.trim().split('\n').sort(), ['taskpilot.toml', 'tests/auth/login-user.test.ts']);
});

test('commit: left unticked, taskpilot.toml stays uncommitted', async () => {
  const { call, g, root } = await commitHarness();
  await fs.writeFile(path.join(root, 'taskpilot.toml'), 'preset = "typescript"\n');
  assert.equal((await call(CHANNELS.commitCreate, 'auth-edge-tests', 'x', ['tests/auth/login-user.test.ts'])).ok, true);
  assert.match((await g(['status', '--porcelain'])).stdout, /^\?\? taskpilot\.toml$/m);
});

test.each(['package-lock.json', 'npm-shrinkwrap.json'])('commit: a saved skeleton can commit only its installation-generated %s', async (lockfile) => {
  const h = await fixtures.harness();
  const task = { ...SAMPLE_TASKS[0], id: 'skeleton', title: '搭建项目骨架', fileScope: ['package.json', 'App.tsx'] };
  await h.requirements.publishPackages('skeleton-requirement', { title: task.title, text: task.title }, [task]);
  h.store.add([task]);
  await fs.writeFile(path.join(h.root, 'package.json'), '{"name":"demo","version":"1.0.0"}\n');
  await fs.writeFile(path.join(h.root, 'App.tsx'), 'export {};\n');
  const g = (args: string[]) => fixtures.run('git', args, { cwd: h.root });
  await g(['add', 'package.json', 'App.tsx']);
  await g(['commit', '-qm', 'skeleton']);
  const baseline = (await g(['rev-parse', 'HEAD'])).stdout.trim();
  await h.store.transition(task.id, 'claim', 'human', { baseline });
  await h.store.transition(task.id, 'submit_for_review', 'human');
  await h.store.transition(task.id, 'review_accepted', 'agent');
  await fs.writeFile(path.join(h.root, lockfile), '{"lockfileVersion":3}\n');
  await fs.writeFile(path.join(h.root, 'unrelated.txt'), 'not in scope\n');
  const preview = (await h.call(CHANNELS.commitPreview, task.id)).data;
  assert.deepEqual(preview.files, [lockfile], 'the existing lockfile is part of the manifest package effective scope');
  assert.deepEqual(preview.optional, []);
  assert.ok(preview.skipped.some((item) => item.path === 'unrelated.txt'));
  assert.equal((await h.call(CHANNELS.commitCreate, task.id, 'install lock', preview.files, ['unrelated.txt'])).error.code, 'changes_changed');
  const committed = await h.call(CHANNELS.commitCreate, task.id, '保存依赖锁文件', preview.files);
  assert.equal(committed.ok, true, JSON.stringify(committed.error));
  assert.deepEqual(committed.data.files, [lockfile]);
  assert.deepEqual((await g(['show', '--name-only', '--format=', 'HEAD'])).stdout.trim().split('\n'), [lockfile]);
  assert.equal((await h.call(CHANNELS.commitPreview, task.id)).data.optional.length, 0);
  assert.match((await g(['status', '--porcelain'])).stdout, /unrelated.txt/);
});

test('commit: npm lockfiles cannot be attached to a package without the root manifest in scope', async () => {
  const { call, root } = await commitHarness();
  await fs.writeFile(path.join(root, 'package-lock.json'), '{}\n');
  const preview = (await call(CHANNELS.commitPreview, 'auth-edge-tests')).data;
  assert.deepEqual(preview.optional, []);
  assert.ok(preview.skipped.some((item) => item.path === 'package-lock.json' && item.reason === 'out_of_scope'));
  assert.equal((await call(CHANNELS.commitCreate, 'auth-edge-tests', 'x', preview.files, ['package-lock.json'])).error.code, 'changes_changed');
});
