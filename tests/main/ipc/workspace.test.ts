// IPC channels of the workspace domain (src/main/ipc/workspace.ts).
import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { CHANNELS } from '../../../src/shared/ipc_channels.ts';
import * as workspace from '../../../src/main/workspace.ts';
import * as fixtures from './harness.ts';

// Runs real git and npm processes per test; slow machines and CI need the room.
vi.setConfig({ testTimeout: 20_000 });

test('workspace:open-file opens workspace files and refuses anything outside', async () => {
  const { call, root, revealed, launched } = await fixtures.harness();
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src/a.ts'), 'x\n');
  const opened = await call(CHANNELS.workspaceOpenFile, 'src/a.ts', 4);
  assert.equal(opened.ok, true);
  // Wherever it went, it went with the real path inside the workspace.
  const target = launched.at(-1)?.args.at(-1) ?? revealed.at(-1) ?? '';
  assert.ok(target.endsWith(`${path.sep}src${path.sep}a.ts`) || target.endsWith(`a.ts:4`), target);
  const outside = await call(CHANNELS.workspaceOpenFile, '../../etc/passwd', null);
  assert.equal(outside.ok, false);
  assert.equal(outside.error.code, 'path_outside_workspace');
  const missing = await call(CHANNELS.workspaceOpenFile, 'src/nope.ts', null);
  assert.equal(missing.error.code, 'file_missing');
});

test('diff:stat splits changes by the work package file scope', async () => {
  const { call, root } = await fixtures.harness();
  await call(CHANNELS.transition, 'auth-email-login', 'claim');
  await fs.writeFile(path.join(root, 'src/auth/application/login-user.ts'), 'export const x = 1;\n');
  await fs.writeFile(path.join(root, 'unrelated.ts'), 'export {};\n');
  await fixtures.run('git', ['add', '.'], { cwd: root });

  const { data } = await call(CHANNELS.diffStat, 'auth-email-login');
  assert.deepEqual(data.scope.inScope, ['src/auth/application/login-user.ts']);
  assert.deepEqual(data.scope.outOfScope, ['unrelated.ts']);
  assert.ok(data.scope.untouched.includes('tests/auth/login-user.test.ts'));
});

test('diff:stat reports an untracked file as out of scope', async () => {
  const { call, root } = await fixtures.harness();
  await call(CHANNELS.transition, 'auth-email-login', 'claim');
  // Never staged, so `git diff` alone would miss it entirely.
  await fs.writeFile(path.join(root, 'rogue.ts'), 'export {};\n');
  const { data } = await call(CHANNELS.diffStat, 'auth-email-login');
  assert.deepEqual(data.scope.outOfScope, ['rogue.ts']);
});

test('diff requests are refused before the package is claimed', async () => {
  const { call } = await fixtures.harness();
  const response = await call(CHANNELS.diffStat, 'auth-edge-tests');
  assert.equal(response.error.code, 'no_baseline');
});

test('diff:file refuses a path outside the workspace', async () => {
  const { call } = await fixtures.harness();
  await call(CHANNELS.transition, 'auth-email-login', 'claim');
  for (const candidate of ['../../etc/passwd', '/etc/passwd', 'src/../../secrets']) {
    const response = await call(CHANNELS.diffFile, 'auth-email-login', candidate);
    assert.equal(response.error.code, 'path_outside_workspace', candidate);
  }
});

test('git-backed channels refuse to run without a configured workspace', async () => {
  const { call } = await fixtures.harness({ withRepo: false });
  assert.equal((await call(CHANNELS.diffStat, 'auth-edge-tests')).error.code, 'no_workspace');
  assert.equal((await call(CHANNELS.workspaceInfo)).data.configured, false);
});

test('workspace:set keeps the open repository root whatever the form says', async () => {
  const { call, root } = await fixtures.harness();
  const response = await call(CHANNELS.workspaceSet, { root: '/somewhere/else', commands: { test: 'npm test' } });
  assert.equal(response.ok, true);
  assert.equal(response.data.root, root);
});

test('workspace:set saves command lines and workspace:get returns them as text', async () => {
  const { call, root, repoDir } = await fixtures.harness();
  const saved = await call(CHANNELS.workspaceSet, {
    root,
    commands: { test: 'node --test "tests/a b.test.js"', lint: '', build: 'npm run build' },
  });
  assert.equal(saved.ok, true);
  assert.deepEqual((await workspace.load(repoDir)).commands.test, { command: 'node', args: ['--test', 'tests/a b.test.js'] });

  const { data } = await call(CHANNELS.workspaceGet);
  assert.equal(data.lines.test, "node --test 'tests/a b.test.js'");
  assert.equal(data.lines.lint, '');
  assert.equal(data.lines.build, 'npm run build');
});

test('workspace:set reports shell syntax against the right field', async () => {
  const { call, root, repoDir } = await fixtures.harness();
  const response = await call(CHANNELS.workspaceSet, { root, commands: { lint: 'eslint . && prettier --check .' } });
  assert.equal(response.error.code, 'shell_syntax');
  assert.equal(response.error.field, 'lint');
  assert.equal((await workspace.load(repoDir)).commands.lint, null);
});

test('workspace:check validates and resolves commands without saving', async () => {
  const { call, root, repoDir } = await fixtures.harness();
  const { data } = await call(CHANNELS.workspaceCheck, {
    root,
    commands: { test: 'git status', lint: 'taskpilot-no-such-tool', build: '' },
  });
  assert.equal(data.repo.branch, 'main');
  assert.ok(data.commands.test.resolved, 'git should resolve through PATH');
  assert.equal(data.commands.lint.configured, true);
  assert.equal(data.commands.lint.resolved, null);
  assert.equal(data.commands.build.configured, false);
  assert.equal((await workspace.load(repoDir)).commands.test, null);
});

test('workspace:pick-root returns the picker result or reports unsupported', async () => {
  const { call } = await fixtures.harness();
  assert.equal((await call(CHANNELS.workspacePickRoot)).error.code, 'unsupported');
});

test('workspace:info reports branch and dirty state', async () => {
  const { call, root } = await fixtures.harness();
  const { data } = await call(CHANNELS.workspaceInfo);
  assert.equal(data.configured, true);
  assert.equal(data.branch, 'main');
  assert.equal(data.dirty, false);
  await fs.writeFile(path.join(root, 'new.ts'), 'export {};\n');
  assert.equal((await call(CHANNELS.workspaceInfo)).data.dirty, true);
});

test('verify:run rejects an unknown kind', async () => {
  const { call } = await fixtures.harness();
  const response = await call(CHANNELS.verifyRun, 'rm -rf /');
  assert.equal(response.error.code, 'invalid_argument');
});

test('verify:run reports when no command is configured', async () => {
  const { call } = await fixtures.harness();
  assert.equal((await call(CHANNELS.verifyRun, 'test')).error.code, 'not_configured');
});

test('verify:run pairs results with the task acceptance criteria', async () => {
  const { call, setCommands } = await fixtures.harness();
  setCommands({
    test: {
      command: process.execPath,
      args: ['-e', "console.log('ok 1 - login succeeds with valid credentials\\nnot ok 2 - login failures are indistinguishable')"],
    },
  });
  const { data } = await call(CHANNELS.verifyRun, 'test', 'auth-email-login');
  const byText = Object.fromEntries(data.acceptance.map((a) => [a.text, a]));
  assert.equal(byText['成功返回 token，不暴露用户是否存在'].verified, true);
  assert.equal(byText['用户不存在和密码错误返回相同的错误'].verified, false);
  assert.equal(byText['所有 auth 测试通过，lint 无错误'].manual, true);
});
