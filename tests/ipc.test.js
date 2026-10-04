const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { CHANNELS, registerIpcHandlers } = require('../src/ipc');
const { WorkPackageStore } = require('../src/work-package-store');
const { listTasks } = require('../src/tasks');
const workspace = require('../src/workspace');

const run = promisify(execFile);

async function harness({ withRepo = true } = {}) {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'taskpilot-ipc-'));
  test.after(() => fs.rm(configDir, { recursive: true, force: true }));

  let root = null;
  if (withRepo) {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskpilot-ipc-repo-'));
    test.after(() => fs.rm(root, { recursive: true, force: true }));
    const g = (args) => run('git', args, { cwd: root });
    await g(['init', '-b', 'main', '-q']);
    await g(['config', 'user.email', 'test@example.com']);
    await g(['config', 'user.name', 'Test']);
    await fs.mkdir(path.join(root, 'src/auth/application'), { recursive: true });
    await fs.writeFile(path.join(root, 'src/auth/application/login-user.ts'), 'export {};\n');
    await g(['add', '.']);
    await g(['commit', '-qm', 'init']);
  }

  let config = { root, commands: { test: null, lint: null, build: null } };
  const handlers = new Map();
  const store = await new WorkPackageStore(configDir).load(listTasks());
  registerIpcHandlers(
    { handle: (channel, handler) => handlers.set(channel, handler) },
    { store, configDir, getConfig: () => config, setConfig: (next) => { config = next; } },
  );

  const call = (channel, ...args) => handlers.get(channel)({}, ...args);
  const setCommands = (commands) => { config = { ...config, commands }; };
  return { call, store, root, configDir, setCommands };
}

test('preload references every channel the main process registers', async () => {
  // The sandboxed preload can't import ./ipc, so guard against drift.
  const preload = await fs.readFile(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
  for (const channel of Object.values(CHANNELS)) {
    assert.ok(preload.includes(`'${channel}'`), `preload.js does not reference ${channel}`);
  }
});

test('handlers return {ok:true,data} instead of throwing', async () => {
  const { call } = await harness();
  const response = await call(CHANNELS.listTasks);
  assert.equal(response.ok, true);
  assert.equal(response.data.length, listTasks().length);
});

test('a task view merges the definition with runtime state', async () => {
  const { call } = await harness();
  const { data } = await call(CHANNELS.getTask, 'auth-edge-tests');
  assert.equal(data.title, '补充登录模块边界测试');
  assert.equal(data.status, 'pending');
  assert.equal(data.statusLabel, '待执行');
  assert.deepEqual(data.completedSteps, []);
  assert.deepEqual(data.humanTransitions, ['claim']);
});

test('errors come back as {ok:false,error} with a code', async () => {
  const { call } = await harness();
  const response = await call(CHANNELS.getTask, 'nope');
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'unknown_package');
  const blank = await call(CHANNELS.getTask, '   ');
  assert.equal(blank.error.code, 'invalid_argument');
});

test('claiming reads the baseline from git, not from the renderer', async () => {
  const { call, root } = await harness();
  const response = await call(CHANNELS.transition, 'auth-edge-tests', 'claim', { baseline: 'attacker-supplied' });
  assert.equal(response.ok, true);
  const head = (await run('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
  assert.equal(response.data.baseline, head);
});

test('the renderer cannot act as an agent', async () => {
  const { call, store } = await harness();
  await call(CHANNELS.transition, 'auth-edge-tests', 'claim');
  await call(CHANNELS.transition, 'auth-edge-tests', 'submit_for_review');
  assert.equal(store.get('auth-edge-tests').status, 'in_review');
  // review_passed belongs to the QA agent; the renderer has no way to send it.
  const response = await call(CHANNELS.transition, 'auth-edge-tests', 'review_passed');
  assert.equal(response.error.code, 'wrong_actor');
});

test('diff:stat splits changes by the work package file scope', async () => {
  const { call, root } = await harness();
  await call(CHANNELS.transition, 'auth-email-login', 'claim');
  await fs.writeFile(path.join(root, 'src/auth/application/login-user.ts'), 'export const x = 1;\n');
  await fs.writeFile(path.join(root, 'unrelated.ts'), 'export {};\n');
  await run('git', ['add', '.'], { cwd: root });

  const { data } = await call(CHANNELS.diffStat, 'auth-email-login');
  assert.deepEqual(data.scope.inScope, ['src/auth/application/login-user.ts']);
  assert.deepEqual(data.scope.outOfScope, ['unrelated.ts']);
  assert.ok(data.scope.untouched.includes('tests/auth/login-user.test.ts'));
});

test('diff:stat reports an untracked file as out of scope', async () => {
  const { call, root } = await harness();
  await call(CHANNELS.transition, 'auth-email-login', 'claim');
  // Never staged, so `git diff` alone would miss it entirely.
  await fs.writeFile(path.join(root, 'rogue.ts'), 'export {};\n');
  const { data } = await call(CHANNELS.diffStat, 'auth-email-login');
  assert.deepEqual(data.scope.outOfScope, ['rogue.ts']);
});

test('diff requests are refused before the package is claimed', async () => {
  const { call } = await harness();
  const response = await call(CHANNELS.diffStat, 'auth-edge-tests');
  assert.equal(response.error.code, 'no_baseline');
});

test('diff:file refuses a path outside the workspace', async () => {
  const { call } = await harness();
  await call(CHANNELS.transition, 'auth-email-login', 'claim');
  for (const candidate of ['../../etc/passwd', '/etc/passwd', 'src/../../secrets']) {
    const response = await call(CHANNELS.diffFile, 'auth-email-login', candidate);
    assert.equal(response.error.code, 'path_outside_workspace', candidate);
  }
});

test('git-backed channels refuse to run without a configured workspace', async () => {
  const { call } = await harness({ withRepo: false });
  assert.equal((await call(CHANNELS.diffStat, 'auth-edge-tests')).error.code, 'no_workspace');
  assert.equal((await call(CHANNELS.workspaceInfo)).data.configured, false);
});

test('workspace:set rejects a root that is not a git repository', async () => {
  const { call } = await harness({ withRepo: false });
  const plain = await fs.mkdtemp(path.join(os.tmpdir(), 'taskpilot-plain-'));
  test.after(() => fs.rm(plain, { recursive: true, force: true }));
  const response = await call(CHANNELS.workspaceSet, { root: plain });
  assert.equal(response.error.code, 'not_a_repo');
  assert.equal(response.error.field, 'root');
});

test('workspace:set does not persist a rejected config', async () => {
  // Regression: validation used to run after the file was written, so a bad
  // root survived and was reloaded on the next launch.
  const { call, configDir } = await harness({ withRepo: false });
  const response = await call(CHANNELS.workspaceSet, { root: '/definitely/not/here' });
  assert.equal(response.error.code, 'root_not_found');
  assert.deepEqual(await workspace.load(configDir), workspace.emptyConfig());
});

test('workspace:set rejects a relative root', async () => {
  const { call } = await harness({ withRepo: false });
  assert.equal((await call(CHANNELS.workspaceSet, { root: 'projects/app' })).error.code, 'root_not_absolute');
});

test('workspace:set normalizes a subdirectory to the repository root', async () => {
  // git reports diff paths from the top level, so a subdirectory root would
  // make every file scope miss.
  const { call, root } = await harness();
  const response = await call(CHANNELS.workspaceSet, { root: path.join(root, 'src', 'auth') });
  assert.equal(response.ok, true);
  assert.equal(await fs.realpath(response.data.root), await fs.realpath(root));
});

test('workspace:set saves command lines and workspace:get returns them as text', async () => {
  const { call, root, configDir } = await harness();
  const saved = await call(CHANNELS.workspaceSet, {
    root,
    commands: { test: 'node --test "tests/a b.test.js"', lint: '', build: 'npm run build' },
  });
  assert.equal(saved.ok, true);
  assert.deepEqual((await workspace.load(configDir)).commands.test, { command: 'node', args: ['--test', 'tests/a b.test.js'] });

  const { data } = await call(CHANNELS.workspaceGet);
  assert.equal(data.lines.test, "node --test 'tests/a b.test.js'");
  assert.equal(data.lines.lint, '');
  assert.equal(data.lines.build, 'npm run build');
});

test('workspace:set reports shell syntax against the right field', async () => {
  const { call, root, configDir } = await harness();
  const response = await call(CHANNELS.workspaceSet, { root, commands: { lint: 'eslint . && prettier --check .' } });
  assert.equal(response.error.code, 'shell_syntax');
  assert.equal(response.error.field, 'lint');
  assert.deepEqual(await workspace.load(configDir), workspace.emptyConfig());
});

test('workspace:check validates and resolves commands without saving', async () => {
  const { call, root, configDir } = await harness();
  const { data } = await call(CHANNELS.workspaceCheck, {
    root,
    commands: { test: 'git status', lint: 'taskpilot-no-such-tool', build: '' },
  });
  assert.equal(data.repo.branch, 'main');
  assert.ok(data.commands.test.resolved, 'git should resolve through PATH');
  assert.equal(data.commands.lint.configured, true);
  assert.equal(data.commands.lint.resolved, null);
  assert.equal(data.commands.build.configured, false);
  assert.deepEqual(await workspace.load(configDir), workspace.emptyConfig());
});

test('workspace:pick-root returns the picker result or reports unsupported', async () => {
  const { call } = await harness();
  assert.equal((await call(CHANNELS.workspacePickRoot)).error.code, 'unsupported');
});

test('workspace:info reports branch and dirty state', async () => {
  const { call, root } = await harness();
  const { data } = await call(CHANNELS.workspaceInfo);
  assert.equal(data.configured, true);
  assert.equal(data.branch, 'main');
  assert.equal(data.dirty, false);
  await fs.writeFile(path.join(root, 'new.ts'), 'export {};\n');
  assert.equal((await call(CHANNELS.workspaceInfo)).data.dirty, true);
});

test('verify:run rejects an unknown kind', async () => {
  const { call } = await harness();
  const response = await call(CHANNELS.verifyRun, 'rm -rf /');
  assert.equal(response.error.code, 'invalid_argument');
});

test('verify:run reports when no command is configured', async () => {
  const { call } = await harness();
  assert.equal((await call(CHANNELS.verifyRun, 'test')).error.code, 'not_configured');
});

test('verify:run pairs results with the task acceptance criteria', async () => {
  const { call, setCommands } = await harness();
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

test('step progress round-trips through the store', async () => {
  const { call } = await harness();
  await call(CHANNELS.transition, 'auth-edge-tests', 'claim');
  const { data } = await call(CHANNELS.setStepDone, 'auth-edge-tests', 1, true);
  assert.deepEqual(data.completedSteps, [1]);
  assert.equal((await call(CHANNELS.setStepDone, 'auth-edge-tests', 'x', true)).error.code, 'invalid_step');
});
