import { test, onTestFinished, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { registerIpcHandlers } from '../../src/main/ipc.ts';
import type { IpcDeps, IpcHandle } from '../../src/main/ipc.ts';
import type { IpcResult, TaskView, CliModelCatalog } from '../../src/shared/ipc_types.ts';
import type { CodingPatchPreview, CodingRuntimeStatus } from '../../src/shared/coding_types.ts';
import { parsePatchPreview } from '../../src/main/coding_workspace.ts';
import type { RunStructuredOptions, StructuredResult } from '../../src/main/agents/claude_cli.ts';
import type { Channel } from '../../src/shared/ipc_channels.ts';

// Runs real git and npm processes per test; slow machines and CI need the room.
vi.setConfig({ testTimeout: 20_000 });

// A stand-in agent; tests answer with plain objects or reject.
type FakeAgent = (options: RunStructuredOptions) => Promise<unknown>;
type CodingOverrides = Partial<
  Pick<IpcDeps, 'codingProbe' | 'codingPrepare' | 'codingRun' | 'codingReadPatch' | 'codingApplyPatch' | 'codingClean' | 'codingSnapshot'>
>;
import { CHANNELS } from '../../src/shared/ipc_channels.ts';
import { WorkPackageStore } from '../../src/main/work_package_store.ts';
import { listTasks, setGeneratedTasks } from '../../src/main/tasks.ts';
import { SAMPLE_TASKS } from './fixtures/sample_tasks.ts';
import { RequirementStore } from '../../src/main/requirement_store.ts';
import { ActivityLog } from '../../src/main/activity_log.ts';
import { ReleaseStore } from '../../src/main/release_store.ts';
import { STATE_FILENAME } from '../../src/main/work_package_store.ts';
import * as workspace from '../../src/main/workspace.ts';
import * as preferences from '../../src/main/preferences.ts';
import { createPathResolver } from '../../src/main/shell_env.ts';
import { RepositoryRegistry } from '../../src/main/repositories.ts';
import { TutorStore } from '../../src/main/tutor_store.ts';
import * as git from '../../src/main/git.ts';

const run = promisify(execFile);

// A one-commit repository with src/auth/application/login-user.ts.
const gitRepo = async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'taskpilot-ipc-repo-'));
  onTestFinished(() => fs.rm(repo, { recursive: true, force: true }));
  const g = (args: string[]) => run('git', args, { cwd: repo });
  await g(['init', '-b', 'main', '-q']);
  await g(['config', 'user.email', 'test@example.com']);
  await g(['config', 'user.name', 'Test']);
  await fs.mkdir(path.join(repo, 'src/auth/application'), { recursive: true });
  await fs.writeFile(path.join(repo, 'src/auth/application/login-user.ts'), 'export {};\n');
  await g(['add', '.']);
  await g(['commit', '-qm', 'init']);
  return repo;
};

const harness = async ({
  withRepo = true,
  agent = null,
  seedState = null,
  coding = {},
  modelCatalog,
}: {
  withRepo?: boolean;
  agent?: FakeAgent | null;
  seedState?: Record<string, unknown> | null;
  coding?: CodingOverrides;
  modelCatalog?: IpcDeps['modelCatalog'];
} = {}) => {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'taskpilot-ipc-'));
  // Background agent runs must finish writing before the directory goes.
  let ipc: IpcHandle | null = null;
  onTestFinished(async () => {
    await ipc?.shutdown();
    await fs.rm(configDir, { recursive: true, force: true });
  });
  // Generated packages are module state in tasks.ts; start each test with
  // the sample packages and clear them afterwards.
  setGeneratedTasks(SAMPLE_TASKS);
  onTestFinished(() => setGeneratedTasks([]));

  const root = withRepo ? await gitRepo() : null;

  // As at startup: the test repository is added and open, and its data lives
  // in its own directory under configDir.
  const repositories = await new RepositoryRegistry(configDir).load();
  if (root) await repositories.open((await repositories.add(root)).id);
  const repoDir = repositories.dataDir();
  await fs.mkdir(repoDir, { recursive: true });

  // Saved package state, as if from an earlier session.
  if (seedState) await fs.writeFile(path.join(repoDir, STATE_FILENAME), JSON.stringify(seedState));

  let config = await repositories.loadConfig();
  const handlers = new Map<Channel, (event: unknown, ...args: unknown[]) => any>();
  const store = await new WorkPackageStore(repoDir).load(listTasks());
  // The coding tests below fake the separate-user wrapper; sandbox mode has its own tests.
  let prefs: preferences.Preferences = { ...preferences.defaults(), coding: { isolation: 'separate-user', extraRead: [], extraWrite: [], timeoutMinutes: 30 } };
  const changes: { next: preferences.Preferences; previous: preferences.Preferences }[] = [];
  const revealed: string[] = [];
  const launched: { file: string; args: string[] }[] = [];
  let shellReads = 0;
  const requirements = await new RequirementStore(repoDir).load();
  const activity = new ActivityLog(repoDir, { timeZone: 'Asia/Shanghai' });
  const releases = await new ReleaseStore(repoDir).load();
  const tutor = await new TutorStore(repoDir).load();
  const agentCalls: RunStructuredOptions[] = [];
  // A fake login shell so tests never launch the user's real one.
  const pathResolver = createPathResolver({
    inherited: '/usr/bin:/bin',
    read: async () => {
      shellReads += 1;
      return `/tp/shell/bin:${process.env.PATH}`;
    },
  });
  ipc = registerIpcHandlers(
    { handle: (channel, handler) => handlers.set(channel, handler) },
    {
      store,
      configDir,
      repositories,
      getConfig: () => config,
      setConfig: (next) => {
        config = next;
      },
      getPreferences: () => prefs,
      setPreferences: (next) => {
        prefs = next;
      },
      pathResolver,
      onPreferencesChanged: (next, previous) => changes.push({ next, previous }),
      revealPath: async (dir) => {
        revealed.push(dir);
      },
      revealFile: (file) => void revealed.push(file),
      launchEditor: async (file, args) => void launched.push({ file, args }),
      appVersion: '9.9.9',
      requirements,
      activity,
      releases,
      modelCatalog,
      tutor,
      runAgent: async (options) => {
        agentCalls.push(options);
        if (!agent) throw Object.assign(new Error('no agent in this test'), { code: 'agent_unavailable' });
        return (await agent(options)) as StructuredResult;
      },
      ...coding,
    },
  );

  const call = (channel: Channel, ...args: unknown[]) => handlers.get(channel)!({}, ...args);
  const setCommands = (commands) => {
    config = workspace.normalize({ root: config.root, commands });
  };
  const setRoot = (next) => {
    config = { ...config, root: next };
  };
  const getConfig = () => config;
  return {
    // Null only with withRepo: false, and those tests never read it.
    call,
    store,
    root: root!,
    configDir,
    repoDir,
    repositories,
    activity,
    setCommands,
    setRoot,
    getConfig,
    changes,
    revealed,
    launched,
    requirements,
    agentCalls,
    shellReads: () => shellReads,
    shutdown: () => ipc?.shutdown(),
  };
};

/** Polls until a requirement leaves a running state. */
const settle = async (call, id) => {
  for (let i = 0; i < 200; i += 1) {
    const { data } = await call(CHANNELS.requirementsGet, id);
    if (data.status !== 'clarifying' && data.status !== 'planning') return data;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('requirement never settled');
};

const codingRuntime = (overrides: Partial<CodingRuntimeStatus> = {}): CodingRuntimeStatus => ({
  backend: 'codex',
  protocol: 'codex-exec',
  boundary: 'separate-user',
  available: true,
  version: 'test',
  reason: null,
  config: { user: 'taskpilot-coder', cli: 'codex', model: '', thinking: 'default', timeoutMinutes: 30 },
  ...overrides,
});

// A one-line patch to `file`, previewed as the main process would.
const filePatch = (file: string, line: string, scope?: readonly string[]): CodingPatchPreview =>
  parsePatchPreview(`diff --git a/${file} b/${file}\nindex 1111111..2222222 100644\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-export {};\n+${line}\n`, scope);

type TestCall = (channel: Channel, ...args: unknown[]) => Promise<IpcResult<unknown>>;
const settleCoding = async (call: TestCall, id: string): Promise<TaskView> => {
  let last = 'no response';
  for (let index = 0; index < 200; index += 1) {
    const response = await call(CHANNELS.codingGet, id);
    if (response.ok) {
      const task = response.data as TaskView;
      last = JSON.stringify(task.codingRun);
      if (task.codingRun && ['ready', 'failed', 'cancelled', 'discarded'].includes(task.codingRun.status)) return task;
    } else last = JSON.stringify(response.error);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`coding run never settled: ${last}`);
};
// Polls until the automatic loop reaches `done`.
const settleLoop = async (call: TestCall, id: string, done: (task: TaskView) => boolean): Promise<TaskView> => {
  let last = 'no response';
  for (let index = 0; index < 800; index += 1) {
    const response = await call(CHANNELS.codingGet, id);
    if (response.ok) {
      const task = response.data as TaskView;
      last = JSON.stringify({ status: task.status, run: task.codingRun });
      if (done(task)) return task;
    } else last = JSON.stringify(response.error);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`coding loop never settled: ${last}`);
};

test('agent model IPC isolates scopes, caches local catalogs, and refreshes only the requested catalog', async () => {
  const reads: string[] = [];
  const modelCatalog: NonNullable<IpcDeps['modelCatalog']> = async (cli, scope): Promise<CliModelCatalog> => {
    reads.push(`${scope}:${cli}`);
    return { cli, scope, models: [], defaultModel: `${scope}-${cli}-${reads.length}`, defaultThinking: null, issues: [] };
  };
  const { call } = await harness({ withRepo: false, modelCatalog });
  const analysis = { ok: true, data: { cli: 'pi', scope: 'analysis', models: [], defaultModel: 'analysis-pi-1', defaultThinking: null, issues: [] } };
  assert.deepEqual(await call(CHANNELS.agentModels, { cli: 'pi', scope: 'analysis' }), analysis);
  assert.deepEqual(await call(CHANNELS.agentModels, { cli: 'pi', scope: 'analysis' }), analysis);
  assert.deepEqual(await call(CHANNELS.agentModels, { cli: 'pi', scope: 'coding' }), {
    ok: true,
    data: { cli: 'pi', scope: 'coding', models: [], defaultModel: 'coding-pi-2', defaultThinking: null, issues: [] },
  });
  assert.deepEqual(await call(CHANNELS.agentModels, { cli: 'pi', scope: 'analysis', refresh: true }), {
    ok: true,
    data: { cli: 'pi', scope: 'analysis', models: [], defaultModel: 'analysis-pi-3', defaultThinking: null, issues: [] },
  });
  const invalid = await call(CHANNELS.agentModels, { cli: 'not-a-cli', scope: 'analysis' });
  assert.equal(invalid.ok, false);
  assert.deepEqual(reads, ['analysis:pi', 'coding:pi', 'analysis:pi']);
});

test('coding IPC registers all seven channels and preserves terminal events', async () => {
  const preview = filePatch('tests/auth/login-user.test.ts', 'test("x", () => {});');
  let probeCalls = 0;
  let prepareCalls = 0;
  let runCalls = 0;
  const events = [{ sequence: 0, at: new Date().toISOString(), type: 'text' as const, text: 'done' }];
  const prepare: IpcDeps['codingPrepare'] = async (_root, _baseline, options) => {
    prepareCalls += 1;
    assert.equal(options?.runName?.startsWith('/Users/taskpilot-coder/TaskPilotRuns/'), true);
    assert.ok(options?.signal);
    return { runName: options!.runName!, directory: options!.runName! };
  };
  const runCoding: IpcDeps['codingRun'] = async (options) => {
    runCalls += 1;
    assert.ok(options.signal);
    options.onEvent?.(events[0]);
    return {
      output: 'done',
      usage: { inputTokens: 1, outputTokens: 2, cachedInputTokens: null, reasoningTokens: null, costUsd: null },
      events,
      sessionId: null,
    };
  };
  const h = await harness({
    seedState: {
      'auth-edge-tests': { status: 'in_progress', baseline: 'HEAD', claimedAt: new Date().toISOString(), completedSteps: [], deviations: [], review: null },
    },
    coding: {
      codingProbe: async () => {
        probeCalls += 1;
        return codingRuntime();
      },
      codingPrepare: prepare,
      codingRun: runCoding,
      codingReadPatch: async () => preview,
      codingApplyPatch: async () => ['tests/auth/login-user.test.ts'],
      codingClean: async () => {},
      codingSnapshot: async (_root, baseline) => baseline,
    },
  });
  const status = await h.call(CHANNELS.codingStatus);
  assert.equal(status.ok, true);
  // Development shows the repository copy of the setup script.
  assert.equal((status.data as CodingRuntimeStatus).setupScript, 'scripts/setup-coding-agent-user.sh');
  const started = await h.call(CHANNELS.codingStart, 'auth-edge-tests', { instruction: '实现边界测试' });
  assert.equal(started.ok, true);
  assert.equal((await h.call(CHANNELS.codingGet, 'auth-edge-tests')).ok, true);
  const ready = await settleCoding(h.call, 'auth-edge-tests');
  assert.equal(ready.codingRun?.status, 'ready');
  const fresh = await h.call(CHANNELS.codingGet, 'auth-edge-tests');
  assert.equal(fresh.ok, true);
  if (!fresh.ok) throw new Error(fresh.error.message);
  assert.equal((fresh.data as TaskView).codingRun?.status, 'ready', JSON.stringify(fresh.data));
  const page = await h.call(CHANNELS.codingEvents, 'auth-edge-tests', -1);
  assert.equal(page.ok, true);
  if (!page.ok) throw new Error(page.error.message);
  const eventPage = page.data as { events: { text: string }[] };
  assert.equal(eventPage.events[0]?.text, 'done');
  const patchResponse = await h.call(CHANNELS.codingPatch, 'auth-edge-tests');
  assert.equal(patchResponse.ok, true, JSON.stringify(patchResponse));
  const missingFiles = await h.call(CHANNELS.codingApply, 'auth-edge-tests', { digest: preview.digest, allowHighRisk: true });
  assert.equal(missingFiles.ok, false);
  const applied = await h.call(CHANNELS.codingApply, 'auth-edge-tests', {
    digest: preview.digest,
    allowHighRisk: true,
    files: ['tests/auth/login-user.test.ts'],
  });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  // No submit checks are configured, so the patch goes straight to QA.
  const submitted = await settleLoop(h.call, 'auth-edge-tests', (task) => task.status !== 'in_progress');
  assert.equal(submitted.codingRun?.status, 'submitted');
  assert.equal((await h.call(CHANNELS.codingCancel, 'auth-edge-tests')).data, false);
  assert.equal(probeCalls, 1);
  assert.equal(prepareCalls, 1);
  assert.equal(runCalls, 1);
  await h.shutdown();
});

test('coding shutdown aborts an active run and waits for its settled write', async () => {
  let aborted = false;
  let finish: (() => void) | null = null;
  let markStarted: (() => void) | null = null;
  const runStarted = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const h = await harness({
    seedState: {
      'auth-edge-tests': { status: 'in_progress', baseline: 'HEAD', claimedAt: new Date().toISOString(), completedSteps: [], deviations: [], review: null },
    },
    coding: {
      codingProbe: async () => codingRuntime(),
      codingPrepare: async (_root, _baseline, options) => ({ runName: options!.runName!, directory: options!.runName! }),
      codingRun: async (options) => {
        markStarted?.();
        options.signal!.addEventListener('abort', () => {
          aborted = true;
          finish?.();
        });
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        throw Object.assign(new Error('cancelled'), { code: 'coding_aborted' });
      },
      codingClean: async () => {},
    },
  });
  await h.call(CHANNELS.codingStart, 'auth-edge-tests', { instruction: '等待取消' });
  await runStarted;
  await h.shutdown();
  assert.equal(aborted, true);
  assert.equal((await h.call(CHANNELS.codingGet, 'auth-edge-tests')).data.codingRun?.status, 'cancelled');
});

const CLARIFY_OUTPUT = { title: '邮箱登录', summary: '用户用邮箱和密码登录', questions: ['连续失败几次锁定？'] };
const PLAN_OUTPUT = {
  summary: '一个工作包完成登录。',
  packages: [
    {
      title: '实现登录接口',
      description: '邮箱密码登录',
      module: 'auth',
      tags: ['auth'],
      priority: 'high',
      estimateHours: 2,
      icon: 'key',
      steps: ['创建 `LoginUserUseCase`。'],
      fileScope: ['src/auth/application/login-user.ts'],
      acceptance: [{ text: '成功返回 token', test: 'login succeeds' }],
      difficulty: { level: 'medium', reason: '要用到异步读写数据库。' },
    },
  ],
};
const SUMMARY_OUTPUT = {
  modules: [
    {
      path: 'src/auth/application/login-user.ts',
      purpose: '登录用例占位',
      members: [{ name: 'placeholder', signature: 'export {}' }],
      dependsOn: [],
      notes: ['当前为空模块'],
    },
  ],
  conventions: ['测试放在 tests/ 下'],
  gaps: [],
};
const ADJUDICATE_REPLAN = {
  decision: 'replan',
  reason: '用例文件路径不对',
  changes: ['文件范围改为 `tests/auth/login.test.ts`'],
  revision: { steps: ['在 `tests/auth/login.test.ts` 添加用例。'], fileScope: ['tests/auth/login.test.ts'], acceptance: [{ text: '用例通过' }] },
};
const RELEASE_PLAN = {
  bump: 'minor',
  reason: '新增登录相关能力。',
  notes: { added: ['支持邮箱登录'], fixed: [], changed: [], notes: [] },
  checklist: [
    { text: '确认登录接口的错误码', evidence: ['src/auth/application/login-user.ts', 'src/not-in-input.ts'] },
    { text: '更新 README', evidence: [] },
  ],
};
/** Which agent step a schema belongs to. */
const stepOf = (schema) =>
  schema.properties.hints
    ? 'tutor'
    : schema.properties.bump
      ? 'release'
      : schema.properties.verdict
        ? 'review'
        : schema.properties.decision
          ? 'adjudicate'
          : schema.properties.install
            ? 'env'
            : schema.properties.packages
              ? 'plan'
              : schema.properties.questions
                ? 'clarify'
                : schema.properties.modules
                  ? 'summarize'
                  : 'select';
const TUTOR_ANSWER = {
  explanation: '在测试文件里加一个用例，检查邮箱大小写不同也能登录。',
  hints: ['打开 tests/auth/login-user.test.ts', '仿照已有用例写一个新的 test()'],
  snippet: { language: 'ts', code: "test('email is case-insensitive', () => {\n  // ...\n});" },
  terms: [{ term: '用例', meaning: '一个独立的测试，检查一种情况。' }],
};

/** A fake team answering by which schema it was given. */
const fakeAgent =
  (overrides: Record<string, unknown> = {}) =>
  async ({ schema }) => {
    const output = {
      select: () => overrides.select ?? { files: ['src/auth/application/login-user.ts'] },
      summarize: () => overrides.summarize ?? SUMMARY_OUTPUT,
      clarify: () => overrides.clarify ?? CLARIFY_OUTPUT,
      plan: () => overrides.plan ?? PLAN_OUTPUT,
      review: () => overrides.review ?? QA_PASS,
      env: () => overrides.env ?? ENV_PLAN,
      adjudicate: () => overrides.adjudicate ?? ADJUDICATE_REPLAN,
      release: () => overrides.release ?? RELEASE_PLAN,
      tutor: () => overrides.tutor ?? TUTOR_ANSWER,
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
  const agent: FakeAgent = ({ signal }) =>
    new Promise((_resolve, reject) => {
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
  agents: preferences.defaults().agents,
  coding: { isolation: 'separate-user', extraRead: [], extraWrite: [], timeoutMinutes: 30, ...overrides.coding },
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
  const { call, configDir, repoDir, root } = await harness();
  await call(CHANNELS.workspaceSet, { root, commands: { test: 'npm test' } });
  await call(CHANNELS.preferencesSet, validPrefs());
  await call(CHANNELS.transition, 'auth-edge-tests', 'claim');
  assert.equal((await call(CHANNELS.dataInfo)).data.packages.claimed, 1);

  const { data } = await call(CHANNELS.dataResetProgress);
  assert.equal(data.claimed, 0);
  assert.equal((await call(CHANNELS.getTask, 'auth-edge-tests')).data.status, 'pending');
  assert.equal((await workspace.load(repoDir)).commands.test!.command, 'npm');
  assert.equal((await preferences.load(configDir)).profile.displayName, 'Ada Lovelace');
});

test('data:reveal only ever opens the config directory', async () => {
  const { call, configDir, revealed } = await harness();
  // Arguments from the renderer are ignored.
  await handlersCall(call, CHANNELS.dataReveal, '/etc');
  assert.deepEqual(revealed, [configDir]);
});

test('workspace:open-file opens workspace files and refuses anything outside', async () => {
  const { call, root, revealed, launched } = await harness();
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

const handlersCall = async (call, channel, ...args) => {
  const response = await call(channel, ...args);
  assert.equal(response.ok, true);
  return response.data;
};

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
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const { call, store, root, setCommands } = await harness({
    agent: async () => {
      await held;
      return { output: QA_PASS, costUsd: 0 };
    },
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
  criteria: [
    { index: 0, status: 'met', note: '覆盖' },
    { index: 1, status: 'met', note: '覆盖' },
  ],
  issues: [],
};

/** Claims auth-edge-tests, writes its test file, and submits it. */
const submitEdgeTests = async ({ call, root }) => {
  await call(CHANNELS.transition, 'auth-edge-tests', 'claim');
  await fs.mkdir(path.join(root, 'tests/auth'), { recursive: true });
  await fs.writeFile(path.join(root, 'tests/auth/login-user.test.ts'), 'test("case-insensitive", () => {});\n');
  return call(CHANNELS.transition, 'auth-edge-tests', 'submit_for_review');
};

/** Polls until the package's review leaves 'running'. */
const settleReview = async (call, id) => {
  for (let i = 0; i < 400; i += 1) {
    const { data } = await call(CHANNELS.getTask, id);
    if (data.review?.status !== 'running') return data;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('review never settled');
};

test('review: submitting starts QA, which passes the package on to acceptance', async () => {
  const h = await harness({ agent: fakeAgent() });
  h.setCommands({ test: EDGE_TESTS_PASS });
  const submitted = await submitEdgeTests(h);
  assert.equal(submitted.data.review.status, 'running');

  const task = await settleReview(h.call, 'auth-edge-tests');
  assert.equal(task.status, 'accepting');
  assert.equal(task.review.status, 'passed');
  assert.deepEqual(
    task.review.diff.files.map((f) => f.path),
    ['tests/auth/login-user.test.ts'],
  );
  const qaCall = callFor(h.agentCalls, 'review');
  assert.match(qaCall.prompt, /case-insensitive/);
  assert.equal(task.review.verification.summary.passed, 2);
});

test('review: a QA rejection sends the package back with the issues', async () => {
  const h = await harness({
    agent: fakeAgent({
      review: { ...QA_PASS, verdict: 'reject', issues: [{ severity: 'blocker', text: '用例没有断言', file: 'tests/auth/login-user.test.ts', line: 1 }] },
    }),
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
    agent: ({ signal }) =>
      new Promise((_resolve, reject) => {
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

test('repositories:add rejects a root that is not a git repository', async () => {
  const { call } = await harness({ withRepo: false });
  const plain = await fs.mkdtemp(path.join(os.tmpdir(), 'taskpilot-plain-'));
  onTestFinished(() => fs.rm(plain, { recursive: true, force: true }));
  const response = await call(CHANNELS.repositoriesAdd, plain, true);
  assert.equal(response.error.code, 'not_a_repo');
  assert.equal(response.error.field, 'root');
});

test('repositories:add registers nothing for a rejected root', async () => {
  const { call } = await harness({ withRepo: false });
  assert.equal((await call(CHANNELS.repositoriesAdd, '/definitely/not/here', true)).error.code, 'root_not_found');
  assert.equal((await call(CHANNELS.repositoriesAdd, 'projects/app', true)).error.code, 'root_not_absolute');
  assert.deepEqual((await call(CHANNELS.repositoriesList)).data, { current: null, repositories: [] });
});

test('repositories:add normalizes a subdirectory to the repository root', async () => {
  // git reports diff paths from the top level, so a subdirectory root would
  // make every file scope miss.
  const { call } = await harness({ withRepo: false });
  const root = await gitRepo();
  const response = await call(CHANNELS.repositoriesAdd, path.join(root, 'src'), true);
  assert.equal(response.ok, true);
  assert.equal(response.data.repositories.length, 1);
  assert.equal(await fs.realpath(response.data.repositories[0].root), await fs.realpath(root));
});

test('workspace:set keeps the open repository root whatever the form says', async () => {
  const { call, root } = await harness();
  const response = await call(CHANNELS.workspaceSet, { root: '/somewhere/else', commands: { test: 'npm test' } });
  assert.equal(response.ok, true);
  assert.equal(response.data.root, root);
});

test('workspace:set saves command lines and workspace:get returns them as text', async () => {
  const { call, root, repoDir } = await harness();
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
  const { call, root, repoDir } = await harness();
  const response = await call(CHANNELS.workspaceSet, { root, commands: { lint: 'eslint . && prettier --check .' } });
  assert.equal(response.error.code, 'shell_syntax');
  assert.equal(response.error.field, 'lint');
  assert.equal((await workspace.load(repoDir)).commands.lint, null);
});

test('workspace:check validates and resolves commands without saving', async () => {
  const { call, root, repoDir } = await harness();
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
const envHarness = async (options: { overrides?: Record<string, unknown> } & Record<string, unknown> = {}) => {
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
};

const settleEnv = async (call) => {
  for (let i = 0; i < 400; i += 1) {
    const { data } = await call(CHANNELS.envGet);
    if (data.status !== 'planning') return data;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('environment plan never settled');
};

test('env: plan, confirm steps one by one, then apply the scripts', async () => {
  const { call, repoDir } = await envHarness();
  const started = await call(CHANNELS.envPlan);
  assert.equal(started.data.status, 'planning');
  const view = await settleEnv(call);
  assert.equal(view.status, 'ready', JSON.stringify(view.error));
  assert.deepEqual(view.blockers, []);
  assert.deepEqual(
    view.steps.map((s) => [s.id, s.line]),
    [
      ['install', 'npm install --ignore-scripts --no-audit --no-fund'],
      ['test', 'npm test'],
      ['lint', 'npm run lint'],
    ],
  );

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
  const saved = JSON.parse(await fs.readFile(path.join(repoDir, 'workspace.json'), 'utf8'));
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
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { call } = await envHarness({
    agent: async () => {
      await gate;
      return { output: ENV_PLAN, costUsd: 0 };
    },
  });
  await call(CHANNELS.envPlan);
  assert.equal((await call(CHANNELS.envPlan)).error.code, 'env_busy');
  release();
  assert.equal((await settleEnv(call)).status, 'ready');
});

const settleBaseline = async (call, id) => {
  for (let i = 0; i < 400; i += 1) {
    const { data } = await call(CHANNELS.getTask, id);
    if (data.baselineChecks && data.baselineChecks.status !== 'measuring') return data.baselineChecks;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('baseline never settled');
};

const LEGACY_FAILING = {
  command: process.execPath,
  args: [
    '-e',
    "console.log('ok 1 - login is case-insensitive for the email\\nok 2 - account locks after five failed attempts\\nnot ok 3 - legacy report export'); process.exit(1)",
  ],
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
const settleAdjudication = async (call, id) => {
  for (let i = 0; i < 400; i += 1) {
    const { data } = await call(CHANNELS.getTask, id);
    if (data.adjudication?.status !== 'running') return data;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('adjudication never settled');
};

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
    agent: fakeAgent({
      get adjudicate() {
        return decision === 'dismiss' ? { decision, reason: '按原计划即可', changes: [] } : ADJUDICATE_REPLAN;
      },
    }),
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
      args: [
        '-e',
        "if (require('fs').existsSync('tests/auth/login-user.test.ts')) console.log('ok 1 - login is case-insensitive for the email\\nok 2 - account locks after five failed attempts'); else console.log('ok 1 - placeholder');",
      ],
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

// Appends are not awaited by handlers; poll the overview until `count` events land.
const overviewWith = async (call, count: number) => {
  for (let i = 0; i < 200; i += 1) {
    const { data } = await call(CHANNELS.activityOverview);
    if (data.recent.length >= count) return data;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`expected ${count} activity events`);
};

test('activity: the requirement flow and a claim are recorded, newest first', async () => {
  const { call } = await harness({ agent: fakeAgent() });
  const created = await call(CHANNELS.requirementsCreate, { text: '用户可以用邮箱登录' });
  let item = await settle(call, created.data.id);
  await call(CHANNELS.requirementsPlan, item.id, ['5 次']);
  item = await settle(call, item.id);
  await call(CHANNELS.requirementsPublish, item.id);
  await call(CHANNELS.transition, `${item.id}-wp1`, 'claim');

  const overview = await overviewWith(call, 5);
  assert.deepEqual(
    overview.recent.map((record) => record.kind),
    ['package_transition', 'requirement_published', 'requirement_finished', 'requirement_finished', 'requirement_created'],
  );
  const [claim, published, planned] = overview.recent;
  assert.equal(claim.transition, 'claim');
  assert.equal(claim.actor, 'human');
  assert.equal(claim.title, '实现登录接口');
  assert.equal(published.packageCount, 1);
  assert.equal(planned.step, 'planning');
  assert.equal(overview.timeZone, 'Asia/Shanghai');
  assert.equal(overview.metrics.doneThisWeek, 0);
  // Each fake run costs $0.02: Architect selects and summarizes once, Product Lead clarifies and plans.
  assert.ok(Math.abs(overview.costs.byAgent.architect - 0.04) < 1e-9);
  assert.ok(Math.abs(overview.costs.byAgent['product-lead'] - 0.04) < 1e-9);
  assert.equal(overview.costs.byAgent.qa, 0);
  assert.equal(typeof overview.costs.since, 'string');
});

test('activity: QA finishing a review is recorded as an agent transition', async () => {
  const h = await harness({ agent: fakeAgent() });
  h.setCommands({ test: EDGE_TESTS_PASS });
  await submitEdgeTests(h);
  await settleReview(h.call, 'auth-edge-tests');
  const overview = await overviewWith(h.call, 3);
  const [review] = overview.recent;
  assert.equal(review.transition, 'review_passed');
  assert.equal(review.actor, 'agent');
  assert.equal(review.to, 'accepting');
  assert.ok(Math.abs(overview.costs.byAgent.qa - 0.02) < 1e-9);
});

test('activity: a failed append never fails the action', async () => {
  const h = await harness();
  // A file where the events directory should be makes every append fail.
  await fs.writeFile(path.join(h.repoDir, 'events'), '');
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  onTestFinished(() => errors.mockRestore());
  const claimed = await h.call(CHANNELS.transition, 'auth-edge-tests', 'claim');
  assert.equal(claimed.ok, true);
  await vi.waitFor(() => assert.ok(errors.mock.calls.some(([message]) => message === '[activity] append failed')));
});

test('activity: team status reports busy agents and CLI availability', async () => {
  let release: () => void = () => {};
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { call } = await harness({
    agent: async (options) => {
      await blocked;
      return fakeAgent()(options);
    },
  });
  const created = await call(CHANNELS.requirementsCreate, { text: '邮箱登录' });
  const { team } = (await call(CHANNELS.activityOverview)).data;
  assert.ok(team.busy.includes('architect') || team.busy.includes('product-lead'));
  assert.equal(team.work.length, 1);
  assert.equal(team.work[0].kind, 'requirement');
  assert.deepEqual(team.busy, [team.work[0].agent]);
  release();
  await settle(call, created.data.id);
  const settled = (await call(CHANNELS.activityOverview)).data.team;
  assert.deepEqual(settled.busy, []);
  assert.deepEqual(settled.work, []);
});

// ========== Release Manager ==========

const gitIn = async (root: string, args: string[]) => (await run('git', args, { cwd: root })).stdout.trim();

// Tags the harness's first commit and adds one more, so tag..HEAD has a change.
const releaseRepo = async (root: string) => {
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'demo', version: '0.3.1' }));
  await gitIn(root, ['add', '.']);
  await gitIn(root, ['commit', '-qm', 'chore: add manifest']);
  await gitIn(root, ['tag', 'v0.3.1']);
  await fs.writeFile(path.join(root, 'src/auth/application/login-user.ts'), 'export const login = () => true;\n');
  await gitIn(root, ['commit', '-qam', 'feat: email login']);
  return gitIn(root, ['rev-parse', 'HEAD']);
};

const settleRelease = async (call) => {
  for (let i = 0; i < 200; i += 1) {
    const { data } = await call(CHANNELS.releaseGet);
    if (data.draft && data.draft.status !== 'generating' && !data.running) return data;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('release never settled');
};

const readyRelease = async (h) => {
  const head = await releaseRepo(h.root);
  const started = await h.call(CHANNELS.releaseGenerate);
  assert.equal(started.ok, true, JSON.stringify(started.error));
  const state = await settleRelease(h.call);
  assert.equal(state.draft.status, 'ready', JSON.stringify(state.draft.error));
  return { head, state };
};

test('release: generate from the newest tag yields a ready draft with computed version', async () => {
  const done = { status: 'done', baseline: null, claimedAt: null, completedSteps: [], deviations: [], review: null };
  const h = await harness({ agent: fakeAgent(), seedState: { 'auth-email-login': done } });
  const before = (await h.call(CHANNELS.releaseGet)).data;
  assert.equal(before.configured, true);
  assert.deepEqual(before.startPoint, { kind: 'none', commit: null, label: null, commitCount: 0, commitsTruncated: false, packageCount: 0 });

  await releaseRepo(h.root);
  const preview = (await h.call(CHANNELS.releaseGet)).data.startPoint;
  assert.deepEqual([preview.kind, preview.commitCount, preview.commitsTruncated, preview.packageCount], ['tag', 1, false, 1]);
  assert.equal(h.agentCalls.length, 0, 'the preview never calls the model');

  const started = await h.call(CHANNELS.releaseGenerate);
  assert.equal(started.ok, true);
  const state = await settleRelease(h.call);
  const head = await gitIn(h.root, ['rev-parse', 'HEAD']);
  assert.equal(state.startPoint.kind, 'tag');
  assert.equal(state.startPoint.label, 'v0.3.1');
  assert.equal(state.draft.endCommit, head);
  assert.equal(state.draft.plan.currentVersion, '0.3.1');
  assert.equal(state.draft.plan.nextVersion, '0.4.0');
  assert.deepEqual(state.draft.plan.checklist[0].evidence, ['src/auth/application/login-user.ts']);
  assert.match(state.draft.notesText, /支持邮箱登录/);
  assert.deepEqual(state.draft.input.packageIds, ['auth-email-login']);

  const prompt = callFor(h.agentCalls, 'release').prompt;
  assert.match(prompt, /feat: email login/);
  assert.doesNotMatch(prompt, /chore: add manifest/, 'commits before the tag are not in range');
  assert.doesNotMatch(prompt, /export const login/, 'file contents never reach the prompt');
  assert.match(prompt, /<package id="auth-email-login">/);
});

test('release: a start commit from the renderer must be the start point or a recent commit', async () => {
  const h = await harness({ agent: fakeAgent() });
  const first = await gitIn(h.root, ['rev-parse', 'HEAD']);
  await fs.writeFile(path.join(h.root, 'README.md'), '# demo\n');
  await gitIn(h.root, ['add', '.']);
  await gitIn(h.root, ['commit', '-qm', 'docs: readme']);

  // No release and no tag: the user must pick.
  assert.equal((await h.call(CHANNELS.releaseGenerate)).error.code, 'release_no_start');
  for (const bad of ['HEAD', first.slice(0, 7), '--output=/tmp/x', 'f'.repeat(40), 42]) {
    const response = await h.call(CHANNELS.releaseGenerate, bad);
    assert.equal(response.ok, false, String(bad));
    assert.equal(response.error.code, typeof bad === 'string' ? 'release_bad_start' : 'invalid_argument', String(bad));
    assert.equal(response.error.field ?? 'startCommit', 'startCommit');
  }
  const commits = (await h.call(CHANNELS.releaseRecentCommits)).data;
  assert.deepEqual(
    commits.map((commit) => commit.subject),
    ['docs: readme', 'init'],
  );
  assert.ok(commits.every((commit) => /^[0-9a-f]{40}$/.test(commit.sha) && commit.date));

  // HEAD itself is a recent commit, but the range would be empty.
  assert.equal((await h.call(CHANNELS.releaseGenerate, commits[0].sha)).error.code, 'release_no_changes');
  assert.equal((await h.call(CHANNELS.releaseGenerate, first)).ok, true);
  const state = await settleRelease(h.call);
  assert.equal(state.draft.status, 'ready');
  assert.equal(state.draft.startCommit, first);
  assert.equal(h.agentCalls.filter((c) => stepOf(c.schema) === 'release').length, 1);
});

test('release: finish refuses unchecked items, then records the release and its activity', async () => {
  const h = await harness({ agent: fakeAgent() });
  const { head } = await readyRelease(h);
  assert.equal((await h.call(CHANNELS.releaseFinish)).error.code, 'release_unchecked');
  assert.equal((await h.call(CHANNELS.releaseUpdateDraft, { checked: [0] })).ok, true);
  assert.equal((await h.call(CHANNELS.releaseFinish)).error.code, 'release_unchecked');
  assert.equal((await h.call(CHANNELS.releaseUpdateDraft, { checked: [5] })).error.code, 'invalid_argument');
  assert.equal((await h.call(CHANNELS.releaseUpdateDraft, { notes: 'x'.repeat(20001) })).error.code, 'too_long');
  assert.equal((await h.call(CHANNELS.releaseUpdateDraft, null)).error.code, 'invalid_argument');

  const edited = await h.call(CHANNELS.releaseUpdateDraft, { notes: '### 新增\n\n- 手改的说明', checked: [0, 1] });
  assert.deepEqual(edited.data.draft.checked, [0, 1]);
  const finished = await h.call(CHANNELS.releaseFinish);
  assert.equal(finished.ok, true);
  assert.equal(finished.data.version, '0.4.0');
  assert.equal(finished.data.endCommit, head);
  assert.equal(finished.data.notesText, '### 新增\n\n- 手改的说明');

  const state = (await h.call(CHANNELS.releaseGet)).data;
  assert.equal(state.draft, null);
  assert.equal(state.history.length, 1);
  assert.deepEqual(state.startPoint, { kind: 'release', commit: head, label: '0.4.0', commitCount: 0, commitsTruncated: false, packageCount: 0 });
  assert.equal((await h.call(CHANNELS.releaseGenerate)).error.code, 'release_no_changes');

  const [event] = (await overviewWith(h.call, 1)).recent;
  assert.deepEqual(
    { kind: event.kind, version: event.version, packageCount: event.packageCount },
    { kind: 'release_finished', version: '0.4.0', packageCount: 0 },
  );
});

test('release: write-notes validates the path and prepends under a dated heading', async () => {
  const h = await harness({ agent: fakeAgent() });
  assert.equal((await h.call(CHANNELS.releaseWriteNotes, { path: 'CHANGELOG.md' })).error.code, 'invalid_state');
  await readyRelease(h);
  await fs.mkdir(path.join(h.root, 'outside-link-target'), { recursive: true });
  const elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), 'taskpilot-elsewhere-'));
  onTestFinished(() => fs.rm(elsewhere, { recursive: true, force: true }));
  await fs.symlink(elsewhere, path.join(h.root, 'linked'));

  const refused = {
    '../CHANGELOG.md': 'path_outside_workspace',
    [path.join(h.root, 'CHANGELOG.md')]: 'path_not_relative',
    '.git/CHANGELOG.md': 'path_in_git',
    'CHANGELOG.txt': 'path_not_markdown',
    'secrets.md': 'path_secret',
    'missing-dir/CHANGELOG.md': 'invalid_argument',
    'linked/CHANGELOG.md': 'path_outside_workspace',
    'outside-link-target': 'path_not_markdown',
  };
  for (const [candidate, code] of Object.entries(refused)) {
    const response = await h.call(CHANNELS.releaseWriteNotes, { path: candidate });
    assert.equal(response.ok, false, candidate);
    assert.equal(response.error.code, code, candidate);
    assert.equal(response.error.field, 'path', candidate);
  }
  assert.equal((await h.call(CHANNELS.releaseWriteNotes, {})).error.code, 'invalid_argument');
  assert.deepEqual(await fs.readdir(elsewhere), []);

  await fs.writeFile(path.join(h.root, 'CHANGELOG.md'), '## 0.3.1 — 2026-01-01\n\n- 旧版本\n');
  const written = await h.call(CHANNELS.releaseWriteNotes, { path: './CHANGELOG.md' });
  assert.deepEqual(written.data, { path: 'CHANGELOG.md' });
  const text = await fs.readFile(path.join(h.root, 'CHANGELOG.md'), 'utf8');
  assert.match(text, /^## 0\.4\.0 — \d{4}-\d{2}-\d{2}\n\n### 新增\n\n- 支持邮箱登录\n\n## 0\.3\.1 — 2026-01-01/);

  // A new file in an existing directory is created; nothing is staged.
  assert.equal((await h.call(CHANNELS.releaseWriteNotes, { path: 'src/RELEASE.md' })).ok, true);
  assert.match(await fs.readFile(path.join(h.root, 'src/RELEASE.md'), 'utf8'), /^## 0\.4\.0 — /);
  assert.equal(await gitIn(h.root, ['diff', '--cached', '--name-only']), '');
});

test('release: a running generation shows Release Manager busy and can be cancelled', async () => {
  let unblock: () => void = () => {};
  const blocked = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const h = await harness({
    agent: async (options) => {
      await blocked;
      return fakeAgent()(options);
    },
  });
  await releaseRepo(h.root);
  const started = await h.call(CHANNELS.releaseGenerate);
  assert.equal(started.data.running, true);
  assert.equal(started.data.draft.status, 'generating');
  assert.equal((await h.call(CHANNELS.releaseGenerate)).error.code, 'release_busy');
  assert.ok((await h.call(CHANNELS.activityOverview)).data.team.busy.includes('release-manager'));
  assert.equal((await h.call(CHANNELS.releaseCancel)).data, true);
  unblock();
  const state = await settleRelease(h.call);
  assert.equal(state.draft.status, 'failed');
  assert.equal(state.draft.error.code, 'agent_cancelled');
  assert.equal((await h.call(CHANNELS.releaseCancel)).data, false);
});

test('release: without a workspace the page reports it unconfigured', async () => {
  const { call } = await harness({ withRepo: false });
  const state = (await call(CHANNELS.releaseGet)).data;
  assert.equal(state.configured, false);
  assert.equal(state.startPoint, null);
  assert.equal((await call(CHANNELS.releaseGenerate)).error.code, 'no_workspace');
});

test('repositories: each repository keeps its own requirements, progress and commands', async () => {
  const { call, root } = await harness({ agent: fakeAgent() });
  await call(CHANNELS.workspaceSet, { root, commands: { test: 'npm test' } });
  await call(CHANNELS.transition, 'auth-edge-tests', 'claim');
  const { data: created } = await call(CHANNELS.requirementsCreate, { text: 'first repo' });
  await settle(call, created.id);

  const other = await gitRepo();
  const added = (await call(CHANNELS.repositoriesAdd, other, true)).data;
  assert.equal(added.repositories.length, 2);
  assert.equal(added.repositories.find((repo) => repo.current).root, await git.topLevel(other));
  assert.deepEqual((await call(CHANNELS.requirementsList)).data, []);
  assert.deepEqual((await call(CHANNELS.listTasks)).data, []);
  assert.equal((await call(CHANNELS.workspaceGet)).data.lines.test, '');
  assert.equal((await call(CHANNELS.workspaceInfo)).data.root, await git.topLevel(other));

  const first = added.repositories.find((repo) => !repo.current);
  await call(CHANNELS.repositoriesSwitch, first.id);
  assert.deepEqual(
    (await call(CHANNELS.requirementsList)).data.map((item) => item.text),
    ['first repo'],
  );
  assert.equal((await call(CHANNELS.workspaceGet)).data.lines.test, 'npm test');
});

test('repositories: switching cancels running work and waits for its writes', async () => {
  const agent: FakeAgent = ({ signal }) =>
    new Promise((_resolve, reject) => {
      signal!.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'agent_cancelled' })));
    });
  const { call } = await harness({ agent });
  const { data } = await call(CHANNELS.requirementsCreate, { title: '登录', text: 't' });
  assert.deepEqual((await call(CHANNELS.repositoriesBusy)).data, [{ kind: 'requirement', label: '登录' }]);

  const first = (await call(CHANNELS.repositoriesList)).data.current;
  await call(CHANNELS.repositoriesAdd, await gitRepo(), true);
  assert.deepEqual((await call(CHANNELS.repositoriesBusy)).data, []);
  await call(CHANNELS.repositoriesSwitch, first);
  const item = (await call(CHANNELS.requirementsGet, data.id)).data;
  assert.equal(item.status, 'failed');
  assert.equal(item.error.code, 'agent_cancelled');
});

test('repositories: a moved repository is flagged and can be pointed at its new place', async () => {
  const { call, root } = await harness();
  const { current } = (await call(CHANNELS.repositoriesList)).data;
  const moved = `${root}-moved`;
  await fs.rename(root, moved);
  onTestFinished(() => fs.rm(moved, { recursive: true, force: true }));
  assert.equal((await call(CHANNELS.repositoriesList)).data.repositories[0].missing, true);

  const relocated = (await call(CHANNELS.repositoriesRelocate, current, moved)).data;
  assert.equal(relocated.current, current, 'the id and its data stay');
  assert.equal(relocated.repositories[0].missing, false);
  assert.equal((await call(CHANNELS.workspaceInfo)).data.root, await git.topLevel(moved));
});

test('repositories: switching to an unknown id is refused', async () => {
  const { call } = await harness();
  assert.equal((await call(CHANNELS.repositoriesSwitch, 'nope')).error.code, 'unknown_repository');
});

/* Committing a finished package */

const doneState = { status: 'done', baseline: null, claimedAt: null, completedSteps: [], deviations: [], review: null };

const commitHarness = async () => {
  const h = await harness({ seedState: { 'auth-edge-tests': doneState } });
  const g = (args: string[]) => run('git', args, { cwd: h.root });
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
  const { call } = await harness();
  assert.equal((await call(CHANNELS.commitPreview, 'auth-edge-tests')).error.code, 'invalid_state');
  const { call: callDone } = await commitHarness();
  assert.equal((await callDone(CHANNELS.commitCreate, 'auth-edge-tests', '  \n', ['tests/auth/login-user.test.ts'])).error.code, 'invalid_message');
});

/* Tutor */

const claimedState = { status: 'in_progress', baseline: null, claimedAt: null, completedSteps: [], deviations: [], review: null };

const settleTutor = async (call, id, stepIndex) => {
  for (let i = 0; i < 200; i += 1) {
    const { data } = await call(CHANNELS.tutorGet, id, stepIndex);
    if (data.status !== 'running') return data;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('tutor never settled');
};

test('tutor: answers a step from the committed scope files, once', async () => {
  const { call, root, agentCalls } = await harness({ agent: fakeAgent(), seedState: { 'auth-edge-tests': claimedState } });
  // A tracked scope file is read; an untracked one never is.
  await fs.mkdir(path.join(root, 'tests/auth'), { recursive: true });
  await fs.writeFile(path.join(root, 'tests/auth/login-user.test.ts'), 'untracked draft\n');

  assert.equal((await call(CHANNELS.tutorGet, 'auth-edge-tests', 0)).data.status, 'idle');
  assert.equal((await call(CHANNELS.tutorAsk, 'auth-edge-tests', 0)).data.status, 'running');
  const done = await settleTutor(call, 'auth-edge-tests', 0);
  assert.equal(done.status, 'done', JSON.stringify(done.error));
  assert.equal(done.answer.hints.length, 2);
  const prompt = callFor(agentCalls, 'tutor').prompt;
  assert.match(prompt, /1\. 在 `tests\/auth\/login-user\.test\.ts` 添加邮箱大小写不敏感的用例。 {3}<- this step/);
  assert.match(prompt, /<missing_files>\ntests\/auth\/login-user\.test\.ts/);
  assert.doesNotMatch(prompt, /untracked draft/);

  // Asking again returns the saved answer without another call.
  const calls = agentCalls.length;
  assert.equal((await call(CHANNELS.tutorAsk, 'auth-edge-tests', 0)).data.status, 'done');
  assert.equal(agentCalls.length, calls);
});

test('tutor: bad output fails the step, which can be retried', async () => {
  let output: unknown = { explanation: '', hints: [], snippet: null, terms: [] };
  const agent: FakeAgent = async () => ({ output, costUsd: 0 });
  const { call } = await harness({ agent, seedState: { 'auth-edge-tests': claimedState } });
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  onTestFinished(() => errors.mockRestore());
  await call(CHANNELS.tutorAsk, 'auth-edge-tests', 1);
  const failed = await settleTutor(call, 'auth-edge-tests', 1);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.code, 'agent_bad_output');
  output = TUTOR_ANSWER;
  await call(CHANNELS.tutorAsk, 'auth-edge-tests', 1);
  assert.equal((await settleTutor(call, 'auth-edge-tests', 1)).status, 'done');
});

test('tutor: a running answer can be cancelled; an out-of-range step is refused', async () => {
  const agent: FakeAgent = ({ signal }) =>
    new Promise((_resolve, reject) => {
      signal!.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'agent_cancelled' })));
    });
  const { call } = await harness({ agent, seedState: { 'auth-edge-tests': claimedState } });
  await call(CHANNELS.tutorAsk, 'auth-edge-tests', 0);
  assert.deepEqual((await call(CHANNELS.repositoriesBusy)).data, [{ kind: 'tutor', label: '补充登录模块边界测试' }]);
  assert.equal((await call(CHANNELS.tutorCancel, 'auth-edge-tests', 0)).data, true);
  const state = await settleTutor(call, 'auth-edge-tests', 0);
  assert.equal(state.error.code, 'agent_cancelled');
  assert.equal((await call(CHANNELS.tutorAsk, 'auth-edge-tests', 9)).error.code, 'invalid_step');
});

test('role settings are independent and frozen across an in-flight requirement', async () => {
  const selected = Promise.withResolvers<void>();
  const continueSelection = Promise.withResolvers<void>();
  let firstSelection = true;
  const agent: FakeAgent = async (options) => {
    const step = stepOf(options.schema);
    if (step === 'select' && firstSelection) {
      firstSelection = false;
      selected.resolve();
      await continueSelection.promise;
    }
    if (step === 'summarize') {
      return { output: { ...SUMMARY_OUTPUT, conventions: [options.model === 'architecture-old' ? 'old convention' : 'new convention'] }, costUsd: null };
    }
    if (step === 'clarify') {
      return { output: { ...CLARIFY_OUTPUT, title: options.model === 'product-old' ? '旧产品配置' : '新产品配置' }, costUsd: null };
    }
    return fakeAgent()(options);
  };
  const h = await harness({ agent });
  const firstProfiles = validPrefs();
  firstProfiles.agents.architect = { cli: 'pi', model: 'architecture-old', thinking: 'high' };
  firstProfiles.agents['product-lead'] = { cli: 'grok', model: 'product-old', thinking: 'low' };
  assert.equal((await h.call(CHANNELS.preferencesSet, firstProfiles)).ok, true);
  const originalFinish = h.requirements.finishClarify.bind(h.requirements);
  let completed = Promise.withResolvers<void>();
  vi.spyOn(h.requirements, 'finishClarify').mockImplementation(async (...args) => {
    const result = await originalFinish(...args);
    completed.resolve();
    return result;
  });
  const first = await h.call(CHANNELS.requirementsCreate, { text: '需求一' });
  await selected.promise;
  const nextProfiles = validPrefs();
  nextProfiles.agents.architect = { cli: 'claude', model: 'architecture-new', thinking: 'medium' };
  nextProfiles.agents['product-lead'] = { cli: 'pi', model: 'product-new', thinking: 'xhigh' };
  assert.equal((await h.call(CHANNELS.preferencesSet, nextProfiles)).ok, true);
  continueSelection.resolve();
  await completed.promise;
  const firstResult = (await h.call(CHANNELS.requirementsGet, first.data.id)).data;
  assert.equal(firstResult.title, '旧产品配置');
  assert.match(firstResult.interfaces.text, /old convention/);
  completed = Promise.withResolvers<void>();
  const second = await h.call(CHANNELS.requirementsCreate, { text: '需求二' });
  await completed.promise;
  const secondResult = (await h.call(CHANNELS.requirementsGet, second.data.id)).data;
  assert.equal(secondResult.title, '新产品配置');
  assert.match(secondResult.interfaces.text, /new convention/);
  assert.equal((await h.call(CHANNELS.preferencesGet)).data.agents.qa.cli, 'claude');
});

// A coding harness for auth-email-login, in progress at the repository's
// HEAD. Each round's fake agent edits login-user.ts; applying writes it.
const loopHarness = async ({
  agent = null,
  highRisk = false,
  timesOut = null,
  hold = null,
}: {
  agent?: FakeAgent | null;
  highRisk?: boolean;
  // The CLI run waits on this before it returns.
  hold?: Promise<void> | null;
  // Rounds (1-based) whose CLI run times out after writing its patch.
  timesOut?: ((round: number) => boolean) | null;
} = {}) => {
  const prompts: string[] = [];
  const timeouts: number[] = [];
  const file = highRisk ? 'tests/auth/login-user.test.ts' : 'src/auth/application/login-user.ts';
  const preview = () => filePatch(file, `export const round = ${prompts.length};`, SAMPLE_TASKS[0].fileScope);
  let root = '';
  const h = await harness({
    agent,
    coding: {
      codingProbe: async () => codingRuntime(),
      codingPrepare: async (_root, _baseline, options) => ({ runName: options!.runName!, directory: options!.runName! }),
      codingRun: async (options) => {
        prompts.push(options.prompt);
        timeouts.push(options.timeoutMs!);
        await hold;
        if (timesOut?.(prompts.length)) throw Object.assign(new Error('Coding run timed out'), { code: 'coding_timeout' });
        return {
          output: '',
          usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: null, reasoningTokens: null, costUsd: 0.1 },
          events: [],
          sessionId: null,
        };
      },
      codingReadPatch: async () => preview(),
      codingApplyPatch: async (_root, patch) => {
        await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
        await fs.writeFile(
          path.join(root, file),
          `${patch
            .split('\n')
            .find((line) => line.startsWith('+export'))!
            .slice(1)}\n`,
        );
        return [file];
      },
      codingClean: async () => {},
      codingSnapshot: async (_root, baseline) => baseline,
    },
  });
  root = h.root;
  const head = (await run('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
  await h.store.transition('auth-email-login', 'claim', 'human', { baseline: head });
  return { ...h, prompts, timeouts, preview, file };
};
const applyFirstRound = async (h: Awaited<ReturnType<typeof loopHarness>>, allowHighRisk = false) => {
  await h.call(CHANNELS.codingStart, 'auth-email-login', { instruction: '实现登录' });
  const ready = await settleCoding(h.call, 'auth-email-login');
  assert.equal(ready.codingRun?.status, 'ready');
  const preview = h.preview();
  return h.call(CHANNELS.codingApply, 'auth-email-login', { digest: preview.digest, allowHighRisk, files: [h.file] });
};
const LOGIN_TESTS_FAIL = { command: process.execPath, args: ['-e', "console.log('not ok 1 - login succeeds with valid credentials'); process.exit(1)"] };
const LOGIN_TESTS_PASS = {
  command: process.execPath,
  args: ['-e', "console.log('ok 1 - login succeeds with valid credentials\\nok 2 - login failures are indistinguishable')"],
};

test('coding loop: failing checks go back to the agent until three automatic rounds are used', async () => {
  const h = await loopHarness();
  h.setCommands({ test: LOGIN_TESTS_FAIL });
  assert.equal((await applyFirstRound(h)).ok, true);
  const task = await settleLoop(h.call, 'auth-email-login', (view) => view.codingRun?.halt === 'attempts_exhausted');
  assert.equal(task.status, 'in_progress');
  assert.equal(task.codingRun?.status, 'applied');
  assert.equal(task.codingRun?.attempt, 4);
  assert.deepEqual(
    task.codingRun?.rounds.map((round) => [round.attempt, round.trigger]),
    [
      [1, 'human'],
      [2, 'checks_failed'],
      [3, 'checks_failed'],
    ],
  );
  assert.equal(h.prompts.length, 4);
  assert.doesNotMatch(h.prompts[0], /submit checks failed/);
  assert.match(h.prompts[1], /submit checks failed[\s\S]*login succeeds with valid credentials/);
  // The last automatic round's patch is in the working tree.
  assert.equal(await fs.readFile(path.join(h.root, h.file), 'utf8'), 'export const round = 4;\n');
});

test('coding loop: passing checks submit to QA, and a rejection starts the next round', async () => {
  let reviews = 0;
  const h = await loopHarness({
    agent: async (options) => {
      if (stepOf(options.schema) !== 'review') return fakeAgent()(options);
      reviews += 1;
      const review =
        reviews === 1
          ? { ...QA_PASS, verdict: 'reject', issues: [{ severity: 'major', text: '没有处理空密码', file: 'src/auth/application/login-user.ts', line: 1 }] }
          : QA_PASS;
      return fakeAgent({ review })(options);
    },
  });
  h.setCommands({ test: LOGIN_TESTS_PASS });
  assert.equal((await applyFirstRound(h)).ok, true);
  const task = await settleLoop(h.call, 'auth-email-login', (view) => view.status !== 'in_progress' && view.status !== 'in_review');
  assert.equal(reviews, 2);
  assert.equal(task.codingRun?.status, 'submitted');
  assert.equal(task.codingRun?.attempt, 2);
  assert.equal(task.codingRun?.trigger, 'qa_rejected');
  assert.match(h.prompts[1], /QA rejected[\s\S]*\[major\] src\/auth\/application\/login-user\.ts:1 没有处理空密码/);
  const events = await h.activity.recent({ days: 1, limit: 100 });
  assert.equal(events.filter((event) => event.kind === 'package_transition' && event.transition === 'coding_submitted').length, 2);
});

// The whole path a Coding Agent package takes: one reviewed round, passing
// checks, QA, acceptance and a local commit of the scope files only.
test('end to end: coding round → checks → QA → done → commit', async () => {
  const h = await loopHarness({ agent: async (options) => fakeAgent({ review: QA_PASS })(options) });
  h.setCommands({ test: LOGIN_TESTS_PASS });
  assert.equal((await applyFirstRound(h)).ok, true);
  const finished = await settleLoop(h.call, 'auth-email-login', (view) => view.status === 'done' || view.status === 'accepting');
  // Evidence that needs a human look stops at acceptance; the developer accepts.
  assert.equal(finished.status, 'accepting', JSON.stringify(finished.review));
  assert.equal((await h.call(CHANNELS.transition, 'auth-email-login', 'accepted')).ok, true);
  assert.equal(finished.codingRun?.status, 'submitted');
  assert.equal(finished.codingRun?.attempt, 1);
  const preview = (await h.call(CHANNELS.commitPreview, 'auth-email-login')).data;
  assert.deepEqual(preview.files, [h.file]);
  const commit = await h.call(CHANNELS.commitCreate, 'auth-email-login', preview.message, preview.files);
  assert.equal(commit.ok, true, JSON.stringify(commit.error));
  const { stdout } = await run('git', ['show', '--name-only', '--format=', 'HEAD'], { cwd: h.root });
  assert.deepEqual(stdout.trim().split('\n'), [h.file]);
  assert.equal((await run('git', ['status', '--porcelain', '--', h.file], { cwd: h.root })).stdout, '');
});

test('coding timeout: the round uses the configured limit and keeps the partial patch for review', async () => {
  const h = await loopHarness({ timesOut: (round) => round === 1, agent: async (options) => fakeAgent({ review: QA_PASS })(options) });
  h.setCommands({ test: LOGIN_TESTS_PASS });
  assert.equal((await h.call(CHANNELS.preferencesSet, validPrefs({ coding: { timeoutMinutes: 60 } }))).ok, true);
  assert.equal((await h.call(CHANNELS.codingStatus)).data.config.timeoutMinutes, 60);
  await h.call(CHANNELS.codingStart, 'auth-email-login', { instruction: '实现登录' });
  const task = await settleCoding(h.call, 'auth-email-login');
  assert.deepEqual(h.timeouts, [60 * 60 * 1000]);
  assert.equal(task.codingRun?.status, 'ready');
  assert.equal(task.codingRun?.halt, 'timed_out');
  assert.equal(task.codingRun?.error?.code, 'coding_timeout');
  assert.deepEqual(
    task.codingRun?.files.map((file) => file.path),
    [h.file],
  );
  // The developer can still apply what was written.
  const preview = h.preview();
  assert.equal((await h.call(CHANNELS.codingApply, 'auth-email-login', { digest: preview.digest, allowHighRisk: false, files: [h.file] })).ok, true);
  // Let the checks and review that applying starts finish inside this test.
  await settleLoop(h.call, 'auth-email-login', (view) => view.status === 'accepting');
});

test('coding:active lists the packages with a round or its checks in flight', async () => {
  const release = Promise.withResolvers<void>();
  const h = await loopHarness({ hold: release.promise });
  assert.deepEqual((await h.call(CHANNELS.codingActive)).data, []);
  await h.call(CHANNELS.codingStart, 'auth-email-login', { instruction: '实现登录' });
  assert.deepEqual((await h.call(CHANNELS.codingActive)).data, [{ packageId: 'auth-email-login', title: SAMPLE_TASKS[0].title }]);
  release.resolve();
  await settleCoding(h.call, 'auth-email-login');
  // The round leaves the list once its run has fully settled.
  let active = (await h.call(CHANNELS.codingActive)).data;
  for (let index = 0; index < 100 && active.length; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    active = (await h.call(CHANNELS.codingActive)).data;
  }
  assert.deepEqual(active, []);
});

test('coding timeout: an automatic round that times out is never applied by itself', async () => {
  const h = await loopHarness({ timesOut: (round) => round === 2 });
  h.setCommands({ test: LOGIN_TESTS_FAIL });
  assert.equal((await applyFirstRound(h)).ok, true);
  const task = await settleLoop(h.call, 'auth-email-login', (view) => view.codingRun?.halt === 'timed_out');
  assert.equal(task.codingRun?.status, 'ready');
  assert.equal(task.codingRun?.attempt, 2);
  assert.equal(h.prompts.length, 2);
  // Round 1's patch is still what the working tree holds.
  assert.equal(await fs.readFile(path.join(h.root, h.file), 'utf8'), 'export const round = 1;\n');
});

test('coding loop: an automatic round that touches a high-risk file stops for the developer', async () => {
  const h = await loopHarness({ highRisk: true });
  h.setCommands({ test: LOGIN_TESTS_FAIL });
  assert.equal((await applyFirstRound(h, true)).ok, true);
  const task = await settleLoop(h.call, 'auth-email-login', (view) => view.codingRun?.halt === 'high_risk');
  assert.equal(task.codingRun?.status, 'ready');
  assert.equal(task.codingRun?.attempt, 2);
  assert.equal(h.prompts.length, 2);
});

test('costs: every analysis call is recorded with its CLI, model and work package, priced or not', async () => {
  const h = await harness({
    agent: async (options) => {
      const result = (await fakeAgent()(options)) as StructuredResult;
      return {
        ...result,
        costUsd: null,
        call: { cli: 'pi', provider: 'deepseek', model: 'v4', costUsd: null, tokens: { input: 9, output: 1, cacheRead: 0, cacheWrite: 0 } },
      };
    },
  });
  h.setCommands({ test: EDGE_TESTS_PASS });
  await submitEdgeTests(h);
  await settleReview(h.call, 'auth-edge-tests');
  await h.activity.flush();
  const costs = (await h.activity.window(1)).filter((record) => record.kind === 'agent_cost');
  assert.equal(costs.length, 1);
  assert.deepEqual(costs[0], {
    kind: 'agent_cost',
    agent: 'qa',
    costUsd: null,
    call: { cli: 'pi', provider: 'deepseek', model: 'v4', costUsd: null, tokens: { input: 9, output: 1, cacheRead: 0, cacheWrite: 0 } },
    subject: { kind: 'package', id: 'auth-edge-tests' },
    at: costs[0].at,
  });
});

test('costs: the report rejects other ranges and counts recorded calls', async () => {
  const h = await harness({ agent: fakeAgent() });
  assert.equal((await h.call(CHANNELS.costsReport, 14)).ok, false);
  h.setCommands({ test: EDGE_TESTS_PASS });
  await submitEdgeTests(h);
  await settleReview(h.call, 'auth-edge-tests');
  await h.activity.flush();
  const response = await h.call(CHANNELS.costsReport, 7);
  assert.equal(response.ok, true, JSON.stringify(response));
  const report = response.data as { total: { calls: number; actualUsd: number }; bySubject: { title: string }[]; prices: unknown };
  // fakeAgent reports $0.02 per call.
  assert.equal(report.total.calls, 1);
  assert.equal(report.total.actualUsd, 0.02);
  assert.equal(report.bySubject[0].title, SAMPLE_TASKS.find((task) => task.id === 'auth-edge-tests')?.title);
  assert.equal(report.prices, null);
});

// Publishes a two-package plan where the second depends on the first.
const publishChain = async (h: Awaited<ReturnType<typeof harness>>) => {
  h.agentCalls.length = 0;
  const { data } = await h.call(CHANNELS.requirementsCreate, { text: '用户可以用邮箱登录' });
  await settle(h.call, data.id);
  await h.call(CHANNELS.requirementsPlan, data.id, ['5 次']);
  await settle(h.call, data.id);
  await h.call(CHANNELS.requirementsPublish, data.id);
  return { first: `${data.id}-wp1`, second: `${data.id}-wp2` };
};

test('dependencies: a package waits for its predecessor, and the developer can waive it', async () => {
  const second = { ...PLAN_OUTPUT.packages[0], title: '接入登录路由', dependsOn: [1] };
  const h = await harness({ agent: fakeAgent({ plan: { ...PLAN_OUTPUT, packages: [PLAN_OUTPUT.packages[0], second] } }) });
  const { first, second: next } = await publishChain(h);
  const waiting = (await h.call(CHANNELS.getTask, next)).data as TaskView;
  assert.deepEqual(waiting.dependencies, [{ id: first, title: '实现登录接口', status: 'pending', waived: false, blocking: true }]);

  const refused = await h.call(CHANNELS.transition, next, 'claim');
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, 'dependencies_pending');

  assert.equal((await h.call(CHANNELS.waiveDependency, next, 'someone-else')).ok, false);
  const waived = (await h.call(CHANNELS.waiveDependency, next, first)).data as TaskView;
  assert.deepEqual([waived.dependencies[0].waived, waived.dependencies[0].blocking], [true, false]);
  assert.equal((await h.call(CHANNELS.transition, next, 'claim')).data.status, 'in_progress');
  // Waiving is for packages not started yet.
  assert.equal((await h.call(CHANNELS.waiveDependency, next, first)).error.code, 'invalid_state');
});

test('dependencies: a finished predecessor unblocks, and done records completedAt', async () => {
  const second = { ...PLAN_OUTPUT.packages[0], title: '接入登录路由', dependsOn: [1] };
  const h = await harness({ agent: fakeAgent({ plan: { ...PLAN_OUTPUT, packages: [PLAN_OUTPUT.packages[0], second] } }) });
  const { first, second: next } = await publishChain(h);
  await h.store.transition(first, 'claim', 'human', { baseline: 'HEAD' });
  await h.store.transition(first, 'submit_for_review', 'human');
  await h.store.beginReview(first);
  await h.store.completeReview(first, {
    passed: true,
    reasons: [],
    evidence: [],
    checks: [],
    acceptance: [],
    report: null,
    diff: { files: [], skipped: [], outOfScope: [] },
    costUsd: 0,
  } as never);
  const done = (await h.call(CHANNELS.getTask, first)).data as TaskView;
  assert.equal(done.status, 'done');
  assert.ok(done.completedAt && Date.parse(done.completedAt) >= Date.parse(done.claimedAt as string));
  const unblocked = (await h.call(CHANNELS.getTask, next)).data as TaskView;
  assert.equal(unblocked.dependencies[0].blocking, false);
  assert.equal((await h.call(CHANNELS.transition, next, 'claim')).data.status, 'in_progress');
});

test('milestones: progress follows the requirement packages, and a requirement sits in one plan', async () => {
  const second = { ...PLAN_OUTPUT.packages[0], title: '接入登录路由', dependsOn: [1] };
  const h = await harness({ agent: fakeAgent({ plan: { ...PLAN_OUTPUT, packages: [PLAN_OUTPUT.packages[0], second] } }) });
  const { first } = await publishChain(h);
  const requirementId = first.replace(/-wp1$/, '');
  const created = await h.call(CHANNELS.milestoneCreate, { version: '0.3.0', targetDate: '2026-10-31', requirementIds: [requirementId, 'not-a-requirement'] });
  assert.equal(created.ok, true, JSON.stringify(created));
  let [plan] = (created.data as { milestones: { id: string; requirements: { title: string }[]; done: number; total: number; complete: boolean }[] }).milestones;
  assert.deepEqual([plan.done, plan.total, plan.complete, plan.requirements.length], [0, 2, false, 1]);

  await h.store.transition(first, 'claim', 'human', { baseline: 'HEAD' });
  await h.store.transition(first, 'submit_for_review', 'human');
  await h.store.beginReview(first);
  await h.store.completeReview(first, {
    passed: true,
    reasons: [],
    evidence: [],
    checks: [],
    acceptance: [],
    report: null,
    diff: { files: [], skipped: [], outOfScope: [] },
    costUsd: 0,
  } as never);
  [plan] = (await h.call(CHANNELS.releaseGet)).data.milestones;
  assert.deepEqual([plan.done, plan.total], [1, 2]);

  const other = (await h.call(CHANNELS.milestoneCreate, { version: '0.4.0', requirementIds: [] })).data.milestones.find((item) => item.version === '0.4.0');
  const moved = (await h.call(CHANNELS.milestoneAssign, requirementId, other.id)).data.milestones;
  assert.deepEqual(
    moved.map((item) => [item.version, item.requirementIds.length]),
    [
      ['0.3.0', 0],
      ['0.4.0', 1],
    ],
  );
  assert.equal((await h.call(CHANNELS.milestoneAssign, 'unknown', other.id)).error.code, 'invalid_argument');
  assert.equal((await h.call(CHANNELS.milestoneCreate, { version: 'v1' })).error.code, 'invalid_argument');
});

test('coding isolation: sandbox mode runs under userData as the current user, and later reads follow the run', async () => {
  const seen: { prepare?: unknown; run?: unknown; probe?: unknown; read: unknown[]; clean: unknown[] } = { read: [], clean: [] };
  const preview = filePatch('tests/auth/login-user.test.ts', 'test("x", () => {});');
  const h = await harness({
    seedState: {
      'auth-edge-tests': { status: 'in_progress', baseline: 'HEAD', claimedAt: new Date().toISOString(), completedSteps: [], deviations: [], review: null },
    },
    coding: {
      codingProbe: async (options) => {
        seen.probe = options?.sandbox;
        return codingRuntime({ boundary: 'sandbox' });
      },
      codingPrepare: async (_root, _baseline, options) => {
        seen.prepare = options;
        return { runName: options!.runName!, directory: options!.runName! };
      },
      codingRun: async (options) => {
        seen.run = options.sandbox;
        return {
          output: 'done',
          usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: null, reasoningTokens: null, costUsd: null },
          events: [],
          sessionId: null,
        };
      },
      codingReadPatch: async (_runName, _scope, options) => {
        seen.read.push(options?.sandbox);
        return preview;
      },
      codingApplyPatch: async () => [],
      codingClean: async (_runName, options) => void seen.clean.push(options?.sandbox),
      codingSnapshot: async (_root, baseline) => baseline,
    },
  });
  const saved = await h.call(CHANNELS.preferencesSet, validPrefs({ coding: { isolation: 'sandbox', extraRead: ['/srv/shared'], extraWrite: [] } }));
  assert.equal(saved.ok, true, JSON.stringify(saved));
  await h.call(CHANNELS.codingStatus);
  assert.deepEqual((seen.probe as { extraRead: string[] }).extraRead, ['/srv/shared']);

  await h.call(CHANNELS.codingStart, 'auth-edge-tests', { instruction: '实现边界测试' });
  const ready = await settleCoding(h.call, 'auth-edge-tests');
  const run = ready.codingRun!;
  assert.equal(path.dirname(run.runName), path.join(h.configDir, 'coding-runs'));
  assert.equal(run.user, os.userInfo().username);
  const prepared = seen.prepare as { sandbox?: { runRoot: string }; cli?: string };
  assert.equal(prepared.sandbox?.runRoot, path.join(h.configDir, 'coding-runs'));
  assert.equal(prepared.cli, run.cli);
  assert.ok(seen.run, 'the CLI ran with the sandbox');

  // A run keeps the mode it started in, even after the setting changes.
  await h.call(CHANNELS.preferencesSet, validPrefs());
  await h.call(CHANNELS.codingPatch, 'auth-edge-tests');
  assert.ok(seen.read.at(-1), 'the patch is still read inside the sandbox');
  await h.call(CHANNELS.codingCancel, 'auth-edge-tests');
  assert.ok(seen.clean.at(-1), 'the run is cleaned as a sandbox run');
});
