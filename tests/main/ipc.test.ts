import { test, onTestFinished } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { registerIpcHandlers } from '../../src/main/ipc.ts';
import type { IpcHandle } from '../../src/main/ipc.ts';
import type { RunStructuredOptions, StructuredResult } from '../../src/main/agents/claude_cli.ts';
import type { Channel } from '../../src/shared/ipc_channels.ts';

// A stand-in agent; tests answer with plain objects or reject.
type FakeAgent = (options: RunStructuredOptions) => Promise<unknown>;
import { CHANNELS } from '../../src/shared/ipc_channels.ts';
import { WorkPackageStore } from '../../src/main/work_package_store.ts';
import { listTasks, setGeneratedTasks } from '../../src/main/tasks.ts';
import { RequirementStore } from '../../src/main/requirement_store.ts';
import * as workspace from '../../src/main/workspace.ts';
import * as preferences from '../../src/main/preferences.ts';
import { createPathResolver } from '../../src/main/shell_env.ts';

const run = promisify(execFile);

async function harness({ withRepo = true, agent = null }: { withRepo?: boolean; agent?: FakeAgent | null } = {}) {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'taskpilot-ipc-'));
  // Background agent runs must finish writing before the directory goes.
  let ipc: IpcHandle | null = null;
  onTestFinished(async () => {
    await ipc?.shutdown();
    await fs.rm(configDir, { recursive: true, force: true });
  });
  // Generated packages are module state in tasks.js; start each test clean.
  setGeneratedTasks([]);
  onTestFinished(() => setGeneratedTasks([]));

  let root: string | null = null;
  if (withRepo) {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'taskpilot-ipc-repo-'));
    root = repo;
    onTestFinished(() => fs.rm(repo, { recursive: true, force: true }));
    const g = (args: string[]) => run('git', args, { cwd: repo });
    await g(['init', '-b', 'main', '-q']);
    await g(['config', 'user.email', 'test@example.com']);
    await g(['config', 'user.name', 'Test']);
    await fs.mkdir(path.join(repo, 'src/auth/application'), { recursive: true });
    await fs.writeFile(path.join(repo, 'src/auth/application/login-user.ts'), 'export {};\n');
    await g(['add', '.']);
    await g(['commit', '-qm', 'init']);
  }

  let config = workspace.normalize({ root });
  const handlers = new Map<Channel, (event: unknown, ...args: unknown[]) => any>();
  const store = await new WorkPackageStore(configDir).load(listTasks());
  let prefs = preferences.defaults();
  const changes: { next: preferences.Preferences; previous: preferences.Preferences }[] = [];
  const revealed: string[] = [];
  let shellReads = 0;
  const requirements = await new RequirementStore(configDir).load();
  const agentCalls: RunStructuredOptions[] = [];
  // A fake login shell so tests never launch the user's real one.
  const pathResolver = createPathResolver({
    inherited: '/usr/bin:/bin',
    read: async () => { shellReads += 1; return `/tp/shell/bin:${process.env.PATH}`; },
  });
  ipc = registerIpcHandlers(
    { handle: (channel, handler) => handlers.set(channel, handler) },
    {
      store, configDir, getConfig: () => config, setConfig: (next) => { config = next; },
      getPreferences: () => prefs, setPreferences: (next) => { prefs = next; },
      pathResolver,
      onPreferencesChanged: (next, previous) => changes.push({ next, previous }),
      revealPath: async (dir) => { revealed.push(dir); },
      appVersion: '9.9.9',
      requirements,
      runAgent: async (options) => {
        agentCalls.push(options);
        if (!agent) throw Object.assign(new Error('no agent in this test'), { code: 'agent_unavailable' });
        return (await agent(options)) as StructuredResult;
      },
    },
  );

  const call = (channel: Channel, ...args: unknown[]) => handlers.get(channel)!({}, ...args);
  const setCommands = (commands) => { config = workspace.normalize({ root: config.root, commands }); };
  const setRoot = (next) => { config = { ...config, root: next }; };
  const getConfig = () => config;
  return {
    // Null only with withRepo: false, and those tests never read it.
    call, store, root: root!, configDir, setCommands, setRoot, getConfig, changes, revealed, requirements, agentCalls,
    shellReads: () => shellReads,
  };
}

/** Polls until a requirement leaves a running state. */
async function settle(call, id) {
  for (let i = 0; i < 200; i += 1) {
    const { data } = await call(CHANNELS.requirementsGet, id);
    if (data.status !== 'clarifying' && data.status !== 'planning') return data;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('requirement never settled');
}

const CLARIFY_OUTPUT = { title: '邮箱登录', summary: '用户用邮箱和密码登录', questions: ['连续失败几次锁定？'] };
const PLAN_OUTPUT = {
  summary: '一个工作包完成登录。',
  packages: [{
    title: '实现登录接口', description: '邮箱密码登录', module: 'auth', tags: ['auth'], priority: 'high',
    estimateHours: 2, icon: 'key', steps: ['创建 `LoginUserUseCase`。'],
    fileScope: ['src/auth/application/login-user.ts'],
    acceptance: [{ text: '成功返回 token', test: 'login succeeds' }],
  }],
};
const SUMMARY_OUTPUT = {
  modules: [{
    path: 'src/auth/application/login-user.ts', purpose: '登录用例占位',
    members: [{ name: 'placeholder', signature: 'export {}' }], dependsOn: [], notes: ['当前为空模块'],
  }],
  conventions: ['测试放在 tests/ 下'],
  gaps: [],
};
const ADJUDICATE_REPLAN = {
  decision: 'replan',
  reason: '用例文件路径不对',
  changes: ['文件范围改为 `tests/auth/login.test.ts`'],
  revision: { steps: ['在 `tests/auth/login.test.ts` 添加用例。'], fileScope: ['tests/auth/login.test.ts'], acceptance: [{ text: '用例通过' }] },
};
/** Which agent step a schema belongs to. */
const stepOf = (schema) => schema.properties.verdict ? 'review'
  : schema.properties.decision ? 'adjudicate'
  : schema.properties.install ? 'env'
  : schema.properties.packages ? 'plan'
  : schema.properties.questions ? 'clarify'
  : schema.properties.modules ? 'summarize'
  : 'select';
/** A fake team answering by which schema it was given. */
const fakeAgent = (overrides: Record<string, unknown> = {}) => async ({ schema }) => {
  const output = {
    select: () => overrides.select ?? { files: ['src/auth/application/login-user.ts'] },
    summarize: () => overrides.summarize ?? SUMMARY_OUTPUT,
    clarify: () => overrides.clarify ?? CLARIFY_OUTPUT,
    plan: () => overrides.plan ?? PLAN_OUTPUT,
    review: () => overrides.review ?? QA_PASS,
    env: () => overrides.env ?? ENV_PLAN,
    adjudicate: () => overrides.adjudicate ?? ADJUDICATE_REPLAN,
  }[stepOf(schema)]();
  if (output instanceof Error) throw output;
  return { output, costUsd: 0.02 };
};
const callFor = (calls, step) => calls.find((c) => stepOf(c.schema) === step);

test('requirements: create clarifies, plan publishes into the work queue', async () => {
  const { call, agentCalls } = await harness({ agent: fakeAgent() });
  const created = await call(CHANNELS.requirementsCreate, { text: '用户可以用邮箱登录' });
  assert.equal(created.data.status, 'clarifying');

  let item = await settle(call, created.data.id);
  assert.equal(item.status, 'answering');
  assert.equal(item.questions[0].text, '连续失败几次锁定？');
  // Architect read the file; Product Lead saw the summary, never the source.
  assert.match(callFor(agentCalls, 'summarize').prompt, /<file path="src\/auth\/application\/login-user\.ts">\nexport \{\};/);
  const clarifyCall = callFor(agentCalls, 'clarify');
  assert.match(clarifyCall.prompt, /<interface_summary author="Architect">\nsrc\/auth\/application\/login-user\.ts: 登录用例占位/);
  assert.doesNotMatch(clarifyCall.prompt, /<file path=/);
  assert.equal(item.interfaces.read[0].path, 'src/auth/application/login-user.ts');

  await call(CHANNELS.requirementsPlan, item.id, ['5 次']);
  item = await settle(call, item.id);
  assert.equal(item.status, 'reviewing');
  const planCall = callFor(agentCalls, 'plan');
  assert.match(planCall.prompt, /A1: 5 次/);
  assert.match(planCall.prompt, /<interface_summary/, 'planning reuses the summary');
  assert.equal(agentCalls.filter((c) => stepOf(c.schema) === 'summarize').length, 1, 'summarized once');

  const published = await call(CHANNELS.requirementsPublish, item.id);
  assert.equal(published.data.status, 'published');
  const queue = (await call(CHANNELS.listTasks)).data;
  assert.equal(queue[0].id, `${item.id}-wp1`, 'generated packages lead the queue');
  assert.deepEqual(queue[0].humanTransitions, ['claim']);

  // The new package is a real work package: it can be claimed.
  const claimed = await call(CHANNELS.transition, `${item.id}-wp1`, 'claim');
  assert.equal(claimed.data.status, 'in_progress');
});

test('requirements: an invalid agent plan fails the run instead of reaching the queue', async () => {
  const evil = { ...PLAN_OUTPUT, packages: [{ ...PLAN_OUTPUT.packages[0], fileScope: ['../../.ssh/id_rsa'] }] };
  const { call } = await harness({ agent: fakeAgent({ plan: evil }) });
  const { data } = await call(CHANNELS.requirementsCreate, { text: 't' });
  await settle(call, data.id);
  await call(CHANNELS.requirementsPlan, data.id, ['']);
  const item = await settle(call, data.id);
  assert.equal(item.status, 'failed');
  assert.equal(item.failedStep, 'planning');
  assert.equal(item.error.code, 'agent_bad_output');
  assert.equal((await call(CHANNELS.requirementsPublish, data.id)).error.code, 'invalid_state');
});

test('requirements: agent errors are recorded and the step can be retried', async () => {
  let fail = true;
  const agent = async (options) => {
    if (fail) throw Object.assign(new Error('Claude Code CLI not found: claude'), { code: 'agent_unavailable' });
    return fakeAgent()(options);
  };
  const { call } = await harness({ agent });
  const { data } = await call(CHANNELS.requirementsCreate, { text: 't' });
  let item = await settle(call, data.id);
  assert.equal(item.error.code, 'agent_unavailable');

  fail = false;
  await call(CHANNELS.requirementsClarify, data.id);
  item = await settle(call, data.id);
  assert.equal(item.status, 'answering');
});

test('requirements: a running step can be cancelled', async () => {
  const agent: FakeAgent = ({ signal }) => new Promise((_resolve, reject) => {
    signal!.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'agent_cancelled' })));
  });
  const { call } = await harness({ agent });
  const { data } = await call(CHANNELS.requirementsCreate, { text: 't' });
  assert.equal((await call(CHANNELS.requirementsCancel, data.id)).data, true);
  const item = await settle(call, data.id);
  assert.equal(item.error.code, 'agent_cancelled');
  assert.equal((await call(CHANNELS.requirementsCancel, data.id)).data, false, 'nothing left to cancel');
});

test('requirements: published requirements cannot be deleted', async () => {
  const { call } = await harness({ agent: fakeAgent() });
  const { data } = await call(CHANNELS.requirementsCreate, { text: 't' });
  await settle(call, data.id);
  await call(CHANNELS.requirementsPlan, data.id, ['']);
  await settle(call, data.id);
  await call(CHANNELS.requirementsPublish, data.id);
  assert.equal((await call(CHANNELS.requirementsRemove, data.id)).error.code, 'invalid_state');
});

test('requirements: create rejects empty text before any agent runs', async () => {
  const { call, agentCalls } = await harness({ agent: fakeAgent() });
  const response = await call(CHANNELS.requirementsCreate, { text: '  ' });
  assert.equal(response.error.field, 'text');
  assert.equal(agentCalls.length, 0);
});

const validPrefs = (overrides: Record<string, object> = {}) => ({
  profile: { displayName: 'Ada Lovelace', avatarColor: 'ocean', ...overrides.profile },
  appearance: { theme: 'dark', vibrancy: false, ...overrides.appearance },
  environment: { pathSource: 'inherit', ...overrides.environment },
});

test('preferences:set saves, returns initials, and notifies the main process', async () => {
  const { call, configDir, changes } = await harness();
  const { data } = await call(CHANNELS.preferencesSet, validPrefs());
  assert.equal(data.profile.initials, 'AL');
  assert.equal((await preferences.load(configDir)).appearance.theme, 'dark');
  assert.equal(changes.length, 1);
  assert.equal(changes[0].previous.appearance.theme, 'system');
  assert.equal((await call(CHANNELS.preferencesGet)).data.profile.displayName, 'Ada Lovelace');
});

test('preferences:set rejects a bad value without saving or notifying', async () => {
  const { call, configDir, changes } = await harness();
  const response = await call(CHANNELS.preferencesSet, validPrefs({ profile: { displayName: 'x'.repeat(41) } }));
  assert.equal(response.error.code, 'name_too_long');
  assert.equal(response.error.field, 'displayName');
  assert.deepEqual(await preferences.load(configDir), preferences.defaults());
  assert.equal(changes.length, 0);
});

test('environment:info previews a PATH source and falls back on shell failure', async () => {
  const { call } = await harness();
  const inherit = (await call(CHANNELS.environmentInfo)).data;
  assert.equal(inherit.source, 'inherit');
  assert.deepEqual(inherit.entries, ['/usr/bin', '/bin']);
  assert.equal(inherit.versions.app, '9.9.9');

  const login = (await call(CHANNELS.environmentInfo, { source: 'login-shell' })).data;
  assert.equal(login.source, 'login-shell');
  assert.equal(login.entries[0], '/tp/shell/bin');

  assert.equal((await call(CHANNELS.environmentInfo, { source: 'bogus' })).error.code, 'invalid_argument');
});

test('environment:info refresh re-reads the login shell', async () => {
  const { call, shellReads } = await harness();
  await call(CHANNELS.environmentInfo, { source: 'login-shell' });
  await call(CHANNELS.environmentInfo, { source: 'login-shell' });
  assert.equal(shellReads(), 1, 'second call is cached');
  await call(CHANNELS.environmentInfo, { source: 'login-shell', refresh: true });
  assert.equal(shellReads(), 2);
});

test('verify:run uses the login-shell PATH once that preference is saved', async () => {
  const { call, setCommands } = await harness();
  setCommands({ test: { command: process.execPath, args: ['-e', 'console.log(process.env.PATH)'] } });
  const before = (await call(CHANNELS.verifyRun, 'test')).data.output.trim();
  assert.equal(before, '/usr/bin:/bin');

  await call(CHANNELS.preferencesSet, validPrefs({ environment: { pathSource: 'login-shell' } }));
  const after = (await call(CHANNELS.verifyRun, 'test')).data.output.trim();
  assert.ok(after.startsWith('/tp/shell/bin:'), after);
});

test('data:reset-progress clears execution state but keeps config and preferences', async () => {
  const { call, configDir, root } = await harness();
  await call(CHANNELS.workspaceSet, { root, commands: { test: 'npm test' } });
  await call(CHANNELS.preferencesSet, validPrefs());
  await call(CHANNELS.transition, 'auth-edge-tests', 'claim');
  assert.equal((await call(CHANNELS.dataInfo)).data.packages.claimed, 1);

  const { data } = await call(CHANNELS.dataResetProgress);
  assert.equal(data.claimed, 0);
  assert.equal((await call(CHANNELS.getTask, 'auth-edge-tests')).data.status, 'pending');
  assert.equal((await workspace.load(configDir)).commands.test!.command, 'npm');
  assert.equal((await preferences.load(configDir)).profile.displayName, 'Ada Lovelace');
});

test('data:reveal only ever opens the config directory', async () => {
  const { call, configDir, revealed } = await harness();
  // Arguments from the renderer are ignored.
  await handlersCall(call, CHANNELS.dataReveal, '/etc');
  assert.deepEqual(revealed, [configDir]);
});

async function handlersCall(call, channel, ...args) {
  const response = await call(channel, ...args);
  assert.equal(response.ok, true);
  return response.data;
}

test('preload exposes every channel the main process registers', async () => {
  // The preload shares CHANNELS with the main process; guard against a
  // channel being registered but never exposed to the renderer.
  const preload = await fs.readFile(path.join(import.meta.dirname, '..', '..', 'src', 'preload', 'index.ts'), 'utf8');
  for (const key of Object.keys(CHANNELS)) {
    assert.ok(new RegExp(`CHANNELS\\.${key}\\b`).test(preload), `preload/index.ts does not reference CHANNELS.${key}`);
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
  // QA starts on submit; hold it so the package stays in review.
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const { call, store, root, setCommands } = await harness({
    agent: async () => { await held; return { output: QA_PASS, costUsd: 0 }; },
  });
  setCommands({ test: EDGE_TESTS_PASS });
  await call(CHANNELS.transition, 'auth-edge-tests', 'claim');
  await fs.mkdir(path.join(root, 'tests/auth'), { recursive: true });
  await fs.writeFile(path.join(root, 'tests/auth/login-user.test.ts'), 'test("x", () => {});\n');
  await call(CHANNELS.transition, 'auth-edge-tests', 'submit_for_review');
  assert.equal(store.get('auth-edge-tests').status, 'in_review');
  // review_passed belongs to the QA agent; the renderer has no way to send it.
  const response = await call(CHANNELS.transition, 'auth-edge-tests', 'review_passed');
  assert.equal(response.error.code, 'wrong_actor');
  release();
});

/* QA review */

const EDGE_TESTS_PASS = {
  command: process.execPath,
  args: ['-e', "console.log('ok 1 - login is case-insensitive for the email\\nok 2 - account locks after five failed attempts')"],
};
const QA_PASS = {
  verdict: 'pass',
  summary: '两个边界用例都已覆盖。',
  criteria: [{ index: 0, status: 'met', note: '覆盖' }, { index: 1, status: 'met', note: '覆盖' }],
  issues: [],
};

/** Claims auth-edge-tests, writes its test file, and submits it. */
async function submitEdgeTests({ call, root }) {
  await call(CHANNELS.transition, 'auth-edge-tests', 'claim');
  await fs.mkdir(path.join(root, 'tests/auth'), { recursive: true });
  await fs.writeFile(path.join(root, 'tests/auth/login-user.test.ts'), 'test("case-insensitive", () => {});\n');
  return call(CHANNELS.transition, 'auth-edge-tests', 'submit_for_review');
}

/** Polls until the package's review leaves 'running'. */
async function settleReview(call, id) {
  for (let i = 0; i < 400; i += 1) {
    const { data } = await call(CHANNELS.getTask, id);
    if (data.review?.status !== 'running') return data;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('review never settled');
}

test('review: submitting starts QA, which passes the package on to acceptance', async () => {
  const h = await harness({ agent: fakeAgent() });
  h.setCommands({ test: EDGE_TESTS_PASS });
  const submitted = await submitEdgeTests(h);
  assert.equal(submitted.data.review.status, 'running');

  const task = await settleReview(h.call, 'auth-edge-tests');
  assert.equal(task.status, 'accepting');
  assert.equal(task.review.status, 'passed');
  assert.deepEqual(task.review.diff.files.map((f) => f.path), ['tests/auth/login-user.test.ts']);
  const qaCall = callFor(h.agentCalls, 'review');
  assert.match(qaCall.prompt, /case-insensitive/);
  assert.equal(task.review.verification.summary.passed, 2);
});

test('review: a QA rejection sends the package back with the issues', async () => {
  const h = await harness({
    agent: fakeAgent({ review: { ...QA_PASS, verdict: 'reject', issues: [{ severity: 'blocker', text: '用例没有断言', file: 'tests/auth/login-user.test.ts', line: 1 }] } }),
  });
  h.setCommands({ test: EDGE_TESTS_PASS });
  await submitEdgeTests(h);
  const task = await settleReview(h.call, 'auth-edge-tests');
  assert.equal(task.status, 'in_progress');
  assert.equal(task.review.status, 'rejected');
  assert.deepEqual(task.review.reasons, ['qa_rejected', 'blocker']);
  assert.equal(task.review.report.issues[0].file, 'tests/auth/login-user.test.ts');
  // The developer can fix and resubmit.
  assert.ok(task.humanTransitions.includes('submit_for_review'));
});

test('review: a failed run stays in review and can be retried', async () => {
  let fail = true;
  const h = await harness({
    agent: async (options) => {
      if (fail) throw Object.assign(new Error('timed out'), { code: 'agent_timeout' });
      return fakeAgent()(options);
    },
  });
  h.setCommands({ test: EDGE_TESTS_PASS });
  await submitEdgeTests(h);
  let task = await settleReview(h.call, 'auth-edge-tests');
  assert.equal(task.status, 'in_review');
  assert.equal(task.review.status, 'failed');
  assert.equal(task.review.error.code, 'agent_timeout');

  fail = false;
  const retried = await h.call(CHANNELS.reviewRetry, 'auth-edge-tests');
  assert.equal(retried.data.review.status, 'running');
  task = await settleReview(h.call, 'auth-edge-tests');
  assert.equal(task.status, 'accepting');
  // A finished review cannot be retried.
  assert.equal((await h.call(CHANNELS.reviewRetry, 'auth-edge-tests')).error.code, 'invalid_state');
});

test('review: cancelling stops QA and leaves the package in review', async () => {
  const h = await harness({
    agent: ({ signal }) => new Promise((_resolve, reject) => {
      signal!.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'agent_cancelled' })));
    }),
  });
  h.setCommands({ test: EDGE_TESTS_PASS });
  await submitEdgeTests(h);
  // Wait until QA is actually waiting on the model.
  while (h.agentCalls.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal((await h.call(CHANNELS.reviewCancel, 'auth-edge-tests')).data, true);
  const task = await settleReview(h.call, 'auth-edge-tests');
  assert.equal(task.status, 'in_review');
  assert.equal(task.review.error.code, 'agent_cancelled');
  assert.equal((await h.call(CHANNELS.reviewCancel, 'auth-edge-tests')).data, false);
});

test('review: failing tests reject without calling the model', async () => {
  const h = await harness({ agent: fakeAgent() });
  h.setCommands({ test: { command: process.execPath, args: ['-e', "console.log('not ok 1 - login is case-insensitive for the email'); process.exit(1)"] } });
  await submitEdgeTests(h);
  const task = await settleReview(h.call, 'auth-edge-tests');
  assert.equal(task.status, 'in_progress');
  assert.ok(task.review.reasons.includes('tests_failed'));
  assert.equal(callFor(h.agentCalls, 'review'), undefined);
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
  onTestFinished(() => fs.rm(plain, { recursive: true, force: true }));
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

const ENV_PLAN = {
  summary: '无依赖项目，安装后即可运行测试。',
  install: { mode: 'install', reason: '没有 lockfile' },
  scripts: { test: 'test', lint: 'lint', build: '' },
  issues: [],
};

/** Commits a dependency-free package.json and switches to the login-shell PATH so node/npm resolve. */
async function envHarness(options: { overrides?: Record<string, unknown> } & Record<string, unknown> = {}) {
  const h = await harness({ agent: fakeAgent(options.overrides), ...options });
  const manifest = {
    name: 'env-fixture',
    private: true,
    scripts: { test: 'node -e "console.log(\'tests ok\')"', lint: 'node -e "console.error(\'lint broke\'); process.exit(3)"' },
  };
  await fs.writeFile(path.join(h.root, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await run('git', ['add', 'package.json'], { cwd: h.root });
  await run('git', ['commit', '-qm', 'manifest'], { cwd: h.root });
  await h.call(CHANNELS.preferencesSet, validPrefs({ environment: { pathSource: 'login-shell' } }));
  return h;
}

async function settleEnv(call) {
  for (let i = 0; i < 400; i += 1) {
    const { data } = await call(CHANNELS.envGet);
    if (data.status !== 'planning') return data;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('environment plan never settled');
}

test('env: plan, confirm steps one by one, then apply the scripts', async () => {
  const { call, configDir } = await envHarness();
  const started = await call(CHANNELS.envPlan);
  assert.equal(started.data.status, 'planning');
  const view = await settleEnv(call);
  assert.equal(view.status, 'ready', JSON.stringify(view.error));
  assert.deepEqual(view.blockers, []);
  assert.deepEqual(view.steps.map((s) => [s.id, s.line]), [
    ['install', 'npm install --ignore-scripts --no-audit --no-fund'],
    ['test', 'npm test'],
    ['lint', 'npm run lint'],
  ]);

  const installed = await call(CHANNELS.envRunStep, 'install');
  assert.equal(installed.ok, true, JSON.stringify(installed.error));
  assert.equal(installed.data.steps[0].result.ok, true, installed.data.steps[0].result.output);

  const tested = (await call(CHANNELS.envRunStep, 'test')).data.steps[1].result;
  assert.equal(tested.ok, true);
  assert.match(tested.output, /tests ok/);

  const linted = (await call(CHANNELS.envRunStep, 'lint')).data.steps[2].result;
  assert.equal(linted.ok, false);
  assert.equal(linted.exitCode, 3);

  const applied = await call(CHANNELS.envApply, ['test']);
  assert.equal(applied.data.configured.test, 'npm test');
  assert.equal(applied.data.configured.lint, '');
  const saved = JSON.parse(await fs.readFile(path.join(configDir, 'workspace.json'), 'utf8'));
  assert.equal(saved.version, 2);
  assert.deepEqual(saved.checks.test, { command: 'npm', args: ['test'], stage: 'submit', blocking: true, report: { format: 'stdout' }, env: {} });
});

test('env: re-planning with a failure hands the steward the failed output', async () => {
  const { call, agentCalls } = await envHarness();
  await call(CHANNELS.envPlan);
  await settleEnv(call);
  await call(CHANNELS.envRunStep, 'lint');
  await call(CHANNELS.envPlan, { withFailure: true });
  const view = await settleEnv(call);
  const prompts = agentCalls.filter((c) => stepOf(c.schema) === 'env').map((c) => c.prompt);
  assert.equal(prompts.length, 2);
  assert.doesNotMatch(prompts[0], /<failed_step>/);
  assert.match(prompts[1], /<failed_step>[\s\S]*npm run lint[\s\S]*lint broke/);
  assert.equal(view.steps.find((s) => s.id === 'lint').result.ok, false, 'unchanged step keeps its result');
});

test('env: allowing lifecycle scripts changes the install line and clears its result', async () => {
  const { call } = await envHarness();
  await call(CHANNELS.envPlan);
  await settleEnv(call);
  const view = (await call(CHANNELS.envSetAllowScripts, true)).data;
  assert.equal(view.allowScripts, true);
  assert.equal(view.steps[0].line, 'npm install --no-audit --no-fund');
});

test('env: steps are refused without a plan, by unknown id, or after the root changes', async () => {
  const { call, setRoot } = await envHarness();
  assert.equal((await call(CHANNELS.envRunStep, 'install')).error.code, 'env_no_plan');
  await call(CHANNELS.envPlan);
  await settleEnv(call);
  assert.equal((await call(CHANNELS.envRunStep, 'rm -rf /')).error.code, 'invalid_argument');
  assert.equal((await call(CHANNELS.envApply, ['build'])).error.code, 'invalid_argument');
  assert.equal((await call(CHANNELS.envApply, ['deploy'])).error.code, 'invalid_argument');
  setRoot(os.tmpdir());
  assert.equal((await call(CHANNELS.envGet)).data.stale, true);
  assert.equal((await call(CHANNELS.envRunStep, 'test')).error.code, 'env_stale');
});

test('env: a repository without package.json is blocked before the model runs', async () => {
  const { call, agentCalls } = await harness({ agent: fakeAgent() });
  await call(CHANNELS.envPlan);
  const view = await settleEnv(call);
  assert.equal(view.status, 'ready');
  assert.ok(view.blockers.includes('no_manifest'));
  assert.equal(view.plan, null);
  assert.deepEqual(view.steps, []);
  assert.equal(agentCalls.length, 0);
});

test('env: a second plan request while one runs is refused', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { call } = await envHarness({ agent: async () => { await gate; return { output: ENV_PLAN, costUsd: 0 }; } });
  await call(CHANNELS.envPlan);
  assert.equal((await call(CHANNELS.envPlan)).error.code, 'env_busy');
  release();
  assert.equal((await settleEnv(call)).status, 'ready');
});

async function settleBaseline(call, id) {
  for (let i = 0; i < 400; i += 1) {
    const { data } = await call(CHANNELS.getTask, id);
    if (data.baselineChecks && data.baselineChecks.status !== 'measuring') return data.baselineChecks;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('baseline never settled');
}

const LEGACY_FAILING = {
  command: process.execPath,
  args: ['-e', "console.log('ok 1 - login is case-insensitive for the email\\nok 2 - account locks after five failed attempts\\nnot ok 3 - legacy report export'); process.exit(1)"],
};

test('baseline: claiming measures submit checks on a clean tree', async () => {
  const h = await harness();
  h.setCommands({ test: LEGACY_FAILING });
  await h.call(CHANNELS.transition, 'auth-edge-tests', 'claim');
  const baseline = await settleBaseline(h.call, 'auth-edge-tests');
  assert.equal(baseline.status, 'measured');
  assert.deepEqual(baseline.checks.test.failing, ['legacy report export']);
  assert.match(baseline.checks.test.line, /legacy report export/);
});

test('baseline: a dirty tree is not measured, and can be re-measured once clean', async () => {
  const h = await harness();
  h.setCommands({ test: EDGE_TESTS_PASS });
  const tracked = path.join(h.root, 'src/auth/application/login-user.ts');
  await fs.writeFile(tracked, 'export const dirty = 1;\n');
  await h.call(CHANNELS.transition, 'auth-edge-tests', 'claim');
  const dirty = await settleBaseline(h.call, 'auth-edge-tests');
  assert.equal(dirty.status, 'unavailable');
  assert.equal(dirty.reason, 'dirty_tree');

  await run('git', ['checkout', '--', '.'], { cwd: h.root });
  const started = await h.call(CHANNELS.baselineMeasure, 'auth-edge-tests');
  assert.equal(started.ok, true, JSON.stringify(started.error));
  // Wait past the 'unavailable' record left by the first attempt.
  for (let i = 0; i < 400; i += 1) {
    const { data } = await h.call(CHANNELS.getTask, 'auth-edge-tests');
    if (data.baselineChecks?.status === 'measured') break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal((await h.call(CHANNELS.getTask, 'auth-edge-tests')).data.baselineChecks.status, 'measured');
});

test('review: a failure already present at the baseline does not reject', async () => {
  const h = await harness({ agent: fakeAgent() });
  h.setCommands({ test: LEGACY_FAILING });
  await h.call(CHANNELS.transition, 'auth-edge-tests', 'claim');
  await settleBaseline(h.call, 'auth-edge-tests');
  await fs.mkdir(path.join(h.root, 'tests/auth'), { recursive: true });
  await fs.writeFile(path.join(h.root, 'tests/auth/login-user.test.ts'), 'test("case-insensitive", () => {});\n');
  await h.call(CHANNELS.transition, 'auth-edge-tests', 'submit_for_review');
  const task = await settleReview(h.call, 'auth-edge-tests');
  assert.equal(task.status, 'accepting', JSON.stringify(task.review.reasons));
  assert.deepEqual(task.review.checks[0].preexisting, ['legacy report export']);
  assert.ok(task.review.attention.some((a) => a.code === 'preexisting_failures'));
  assert.match(callFor(h.agentCalls, 'review').prompt, /Already failing at the baseline/);
});

test('review: without a baseline the same failure rejects', async () => {
  const h = await harness({ agent: fakeAgent() });
  await h.call(CHANNELS.transition, 'auth-edge-tests', 'claim');
  await settleBaseline(h.call, 'auth-edge-tests'); // no checks yet: unavailable
  h.setCommands({ test: LEGACY_FAILING });
  await fs.mkdir(path.join(h.root, 'tests/auth'), { recursive: true });
  await fs.writeFile(path.join(h.root, 'tests/auth/login-user.test.ts'), 'x\n');
  await h.call(CHANNELS.transition, 'auth-edge-tests', 'submit_for_review');
  const task = await settleReview(h.call, 'auth-edge-tests');
  assert.equal(task.status, 'in_progress');
  assert.equal(task.review.checks[0].reason, 'no_baseline');
});

/* Deviations: Architect rules, the human can override */

/** Polls until the package's adjudication leaves 'running'. */
async function settleAdjudication(call, id) {
  for (let i = 0; i < 400; i += 1) {
    const { data } = await call(CHANNELS.getTask, id);
    if (data.adjudication?.status !== 'running') return data;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('adjudication never settled');
}

const reportDeviation = async ({ call }) => {
  await call(CHANNELS.transition, 'auth-edge-tests', 'claim');
  return call(CHANNELS.transition, 'auth-edge-tests', 'report_deviation', {
    deviation: { note: '测试文件应该叫 login.test.ts', filePath: 'src/auth/application/login-user.ts' },
  });
};

test('deviation: Architect reads the code and its replan becomes the package, which the human can revert', async () => {
  const h = await harness({ agent: fakeAgent() });
  const reported = await reportDeviation(h);
  assert.equal(reported.data.adjudication.status, 'running');

  let task = await settleAdjudication(h.call, 'auth-edge-tests');
  assert.equal(task.status, 'pending');
  assert.deepEqual(task.fileScope, ['tests/auth/login.test.ts']);
  assert.equal(task.revision.version, 1);
  assert.ok(task.humanTransitions.includes('revert_replan'));
  // The file named in the deviation was read from git and sent to Architect.
  const prompt = callFor(h.agentCalls, 'adjudicate').prompt;
  assert.match(prompt, /<file path="src\/auth\/application\/login-user\.ts">\nexport \{\};/);
  assert.match(prompt, /D1 \[file src\/auth\/application\/login-user\.ts\]: 测试文件应该叫 login\.test\.ts/);

  const reverted = await h.call(CHANNELS.transition, 'auth-edge-tests', 'revert_replan');
  assert.equal(reverted.data.status, 'in_progress');
  task = (await h.call(CHANNELS.getTask, 'auth-edge-tests')).data;
  assert.deepEqual(task.fileScope, ['tests/auth/login-user.test.ts']);
  assert.equal(task.revision, null);
});

test('deviation: a contested dismissal goes back to Architect, which must replan', async () => {
  let decision = 'dismiss';
  const h = await harness({
    agent: fakeAgent({ get adjudicate() { return decision === 'dismiss' ? { decision, reason: '按原计划即可', changes: [] } : ADJUDICATE_REPLAN; } }),
  });
  await reportDeviation(h);
  let task = await settleAdjudication(h.call, 'auth-edge-tests');
  assert.equal(task.status, 'in_progress');
  assert.equal(task.deviations[0].resolution.decision, 'dismiss');
  assert.ok(task.humanTransitions.includes('override_dismissal'));

  decision = 'replan';
  await h.call(CHANNELS.transition, 'auth-edge-tests', 'override_dismissal');
  task = await settleAdjudication(h.call, 'auth-edge-tests');
  assert.equal(task.status, 'pending');
  const prompts = h.agentCalls.filter((c) => stepOf(c.schema) === 'adjudicate').map((c) => c.prompt);
  assert.match(prompts[1], /contested your earlier dismissal/);
});

test('deviation: a failed ruling stays in deviation and can be retried', async () => {
  let fail = true;
  const h = await harness({
    agent: async (options) => {
      if (fail) throw Object.assign(new Error('timed out'), { code: 'agent_timeout' });
      return fakeAgent()(options);
    },
  });
  await reportDeviation(h);
  let task = await settleAdjudication(h.call, 'auth-edge-tests');
  assert.equal(task.status, 'deviation');
  assert.equal(task.adjudication.error.code, 'agent_timeout');

  fail = false;
  await h.call(CHANNELS.deviationRetry, 'auth-edge-tests');
  task = await settleAdjudication(h.call, 'auth-edge-tests');
  assert.equal(task.status, 'pending');
});

test('review: a clean pass with a measured baseline finishes the package without the human', async () => {
  const h = await harness({ agent: fakeAgent() });
  // The linked tests only exist once the developer writes the file, so the
  // baseline cannot already pass them.
  h.setCommands({
    test: {
      command: process.execPath,
      args: ['-e', "if (require('fs').existsSync('tests/auth/login-user.test.ts')) console.log('ok 1 - login is case-insensitive for the email\\nok 2 - account locks after five failed attempts'); else console.log('ok 1 - placeholder');"],
    },
  });
  await h.call(CHANNELS.transition, 'auth-edge-tests', 'claim');
  await settleBaseline(h.call, 'auth-edge-tests');
  await fs.mkdir(path.join(h.root, 'tests/auth'), { recursive: true });
  await fs.writeFile(path.join(h.root, 'tests/auth/login-user.test.ts'), 'test("case-insensitive", () => {});\n');
  await h.call(CHANNELS.transition, 'auth-edge-tests', 'submit_for_review');
  const task = await settleReview(h.call, 'auth-edge-tests');
  assert.deepEqual(task.review.attention, []);
  assert.equal(task.status, 'done');
});
