// IPC channels of the workspace domain (src/main/ipc/workspace.ts).
import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { CHANNELS } from '../../../src/shared/ipc_channels.ts';
import * as workspace from '../../../src/main/repository/workspace.ts';
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
  await call(CHANNELS.packagesTransition, 'auth-email-login', 'claim');
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
  await call(CHANNELS.packagesTransition, 'auth-email-login', 'claim');
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
  await call(CHANNELS.packagesTransition, 'auth-email-login', 'claim');
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

const lines = (id: string, stepLines: string[], extra: Record<string, unknown> = {}) => ({
  [id]: {
    enabled: true,
    lines: stepLines,
    cwd: '',
    stage: id === 'test' ? 'submit' : 'step',
    blocking: id === 'test',
    parser: { format: 'tests' },
    timeoutSeconds: null,
    ...extra,
  },
});

test('workspace:set keeps the open repository root whatever the form says', async () => {
  const { call, root } = await fixtures.harness();
  const response = await call(CHANNELS.workspaceSet, { root: '/somewhere/else', steps: lines('test', ['npm test']) });
  assert.equal(response.ok, true, JSON.stringify(response.error));
  assert.equal(response.data.root, root);
});

test('workspace:set saves step command lines and workspace:get returns every step', async () => {
  const { call, root, repoDir } = await fixtures.harness();
  const saved = await call(CHANNELS.workspaceSet, {
    root,
    steps: {
      ...lines('test', ['node --test "tests/a b.test.js"']),
      ...lines('build', ['npm run build', 'npm run bundle'], { timeoutSeconds: 90 }),
      coverage: { enabled: false, lines: [] },
    },
  });
  assert.equal(saved.ok, true, JSON.stringify(saved.error));
  const config = await workspace.load(repoDir);
  assert.deepEqual(config.steps.test?.commands, [{ command: 'node', args: ['--test', 'tests/a b.test.js'] }]);
  assert.equal(config.steps.build?.commands.length, 2);
  assert.equal(config.steps.build?.timeoutMs, 90000);
  assert.equal(config.steps.coverage?.enabled, false);

  const { data } = await call(CHANNELS.workspaceGet);
  const byId = Object.fromEntries(data.steps.map((step) => [step.id, step]));
  assert.deepEqual(
    data.steps.map((step) => step.id),
    ['setup', 'build', 'format', 'lint', 'typecheck', 'test', 'coverage'],
  );
  assert.deepEqual(byId.test.effective.lines, ["node --test 'tests/a b.test.js'"]);
  assert.equal(byId.test.source, 'local');
  assert.deepEqual(byId.build.local.lines, ['npm run build', 'npm run bundle']);
  assert.equal(byId.lint.skipped, 'not_configured');
  assert.equal(byId.coverage.skipped, 'disabled');
  assert.deepEqual(data.project, { status: 'missing' });
});

test('workspace:create-project writes taskpilot.toml once, and its steps then run', async () => {
  const { call, root } = await fixtures.harness();
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { lint: 'node -e "process.exit(0)"' } }));
  const created = await call(CHANNELS.workspaceCreateProject, 'typescript');
  assert.equal(created.ok, true, JSON.stringify(created.error));
  assert.deepEqual(created.data.project, { status: 'ok', preset: 'typescript' });
  const text = await fs.readFile(path.join(root, 'taskpilot.toml'), 'utf8');
  assert.match(text, /^preset = "typescript"$/m);
  // The commented examples are the preset's suggestions, not fixed npm lines.
  assert.match(text, /^# commands = \["npx eslint \."\]$/m);
  assert.match(text, /^# commands = \["npx tsc --noEmit"\]$/m);
  assert.equal((await call(CHANNELS.workspaceCreateProject, 'none')).error.code, 'invalid_project');
  assert.equal((await call(CHANNELS.workspaceCreateProject, 'cobol')).error.code, 'invalid_argument');
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

test('workspace:get reports the course pack, and workspace:confirm-course confirms only what was shown', async () => {
  const { call, root } = await fixtures.harness();
  let { data } = await call(CHANNELS.workspaceGet);
  assert.deepEqual(data.course.selected, { id: 'programming', from: 'default' });
  assert.deepEqual(data.course.state, { status: 'ok' });

  await fs.writeFile(path.join(root, 'taskpilot.toml'), 'course = "oslab"\n');
  await fs.mkdir(path.join(root, '.taskpilot/courses'), { recursive: true });
  await fs.writeFile(path.join(root, '.taskpilot/courses/oslab.toml'), fixtures.OS_PACK);
  ({ data } = await call(CHANNELS.workspaceGet));
  assert.deepEqual(data.course.selected, { id: 'oslab', from: 'project' });
  assert.equal(data.course.state.status, 'pending');
  assert.equal(data.course.ref.id, 'programming');
  const shown = data.course.state.ref;

  const stale = await call(CHANNELS.workspaceConfirmCourse, 'oslab', 'f'.repeat(64));
  assert.equal(stale.error.code, 'course_changed');
  const other = await call(CHANNELS.workspaceConfirmCourse, 'programming', shown.contentHash);
  assert.equal(other.error.code, 'course_not_pending');

  const confirmed = await call(CHANNELS.workspaceConfirmCourse, 'oslab', shown.contentHash);
  assert.equal(confirmed.ok, true);
  assert.deepEqual(confirmed.data.course.state, { status: 'ok' });
  assert.deepEqual(confirmed.data.course.ref, shown);
});
