// IPC channels of the commit domain (src/main/ipc/commit.ts).
import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { CHANNELS } from '../../../src/shared/ipc_channels.ts';
import * as fixtures from './harness.ts';

// Runs real git and npm processes per test; slow machines and CI need the room.
vi.setConfig({ testTimeout: 20_000 });

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
