// Shared by the IPC tests: a registered app over a temporary git repository,
// fake agents and the polls that wait for background runs.
import { onTestFinished } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { registerIpcHandlers } from '../../../src/main/ipc.ts';
import type { IpcHandle } from '../../../src/main/ipc.ts';
import type { AgentDeps, ShellDeps } from '../../../src/main/app_context.ts';
import type { CodingDeps } from '../../../src/main/coding_runtime.ts';
import type { IpcResult } from '../../../src/shared/ipc/envelope.ts';
import type { TaskView } from '../../../src/shared/ipc/packages.ts';
import type { CodingPatchPreview, CodingRuntimeStatus } from '../../../src/shared/coding_types.ts';
import { parsePatchPreview } from '../../../src/main/coding_workspace.ts';
import type { RunStructuredOptions, StructuredResult } from '../../../src/main/agents/claude_cli.ts';
import type { Channel } from '../../../src/shared/ipc_channels.ts';
import { CHANNELS } from '../../../src/shared/ipc_channels.ts';
import { WorkPackageStore } from '../../../src/main/work_package_store.ts';
import { SAMPLE_REQUIREMENT } from '../fixtures/sample_tasks.ts';
import { REQUIREMENTS_FILENAME, RequirementStore } from '../../../src/main/requirement_store.ts';
import { ActivityLog } from '../../../src/main/activity_log.ts';
import { ReleaseStore } from '../../../src/main/release_store.ts';
import { STATE_FILENAME } from '../../../src/main/work_package_store.ts';
import * as workspace from '../../../src/main/workspace.ts';
import * as preferences from '../../../src/main/preferences.ts';
import { createPathResolver } from '../../../src/main/shell_env.ts';
import { RepositoryRegistry } from '../../../src/main/repositories.ts';
import { TutorStore } from '../../../src/main/tutor_store.ts';
import { NoteStore } from '../../../src/main/note_store.ts';

// A stand-in agent; tests answer with plain objects or reject.
export type FakeAgent = (options: RunStructuredOptions) => Promise<unknown>;
// Coding executor and CLI stand-ins, named as the harness passes them on.
export type CodingOverrides = {
  codingProbe?: CodingDeps['probe'];
  codingPrepare?: CodingDeps['prepare'];
  codingRun?: CodingDeps['run'];
  codingReadPatch?: CodingDeps['readPatch'];
  codingApplyPatch?: CodingDeps['applyPatch'];
  codingClean?: CodingDeps['clean'];
  codingSnapshot?: CodingDeps['snapshot'];
  codingPreviewMerge?: CodingDeps['previewMerge'];
  pickDirectory?: ShellDeps['pickDirectory'];
  probeAgent?: AgentDeps['probeAgent'];
  checkSignIn?: AgentDeps['checkSignIn'];
};

export const run = promisify(execFile);

// A one-commit repository with src/auth/application/login-user.ts.
const createGitRepo = async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'taskpilot-ipc-repo-'));
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

export const gitRepo = async () => {
  const repo = await createGitRepo();
  onTestFinished(() => fs.rm(repo, { recursive: true, force: true }));
  return repo;
};

export const harness = async ({
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
  modelCatalog?: AgentDeps['modelCatalog'];
} = {}) => {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'taskpilot-ipc-'));
  // Background agent runs must finish writing before the directory goes.
  // onTestFinished hooks run last-registered-first, so the repository is
  // removed here, after shutdown, not by a hook of its own.
  let ipc: IpcHandle | null = null;
  let root: string | null = null;
  onTestFinished(async () => {
    await ipc?.shutdown();
    await fs.rm(configDir, { recursive: true, force: true, maxRetries: 5 });
    if (root) await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
  });
  root = withRepo ? await createGitRepo() : null;

  // As at startup: the test repository is added and open, and its data lives
  // in its own directory under configDir.
  const repositories = await new RepositoryRegistry(configDir).load();
  if (root) await repositories.open((await repositories.add(root)).id);
  const repoDir = repositories.dataDir();
  await fs.mkdir(repoDir, { recursive: true });

  // The sample packages, published in an earlier session.
  await fs.writeFile(path.join(repoDir, REQUIREMENTS_FILENAME), JSON.stringify([SAMPLE_REQUIREMENT]));
  // Saved package state, as if from an earlier session.
  if (seedState) await fs.writeFile(path.join(repoDir, STATE_FILENAME), JSON.stringify(seedState));

  let config = await repositories.loadConfig();
  const handlers = new Map<Channel, (event: unknown, ...args: unknown[]) => any>();
  const requirements = await new RequirementStore(repoDir).load();
  const store = await new WorkPackageStore(repoDir).load(requirements.listTasks());
  // The coding tests below fake the separate-user wrapper; sandbox mode has its own tests.
  let prefs: preferences.Preferences = { ...preferences.defaults(), coding: { isolation: 'separate-user', extraRead: [], extraWrite: [], timeoutMinutes: 30 } };
  const changes: { next: preferences.Preferences; previous: preferences.Preferences }[] = [];
  const revealed: string[] = [];
  const launched: { file: string; args: string[] }[] = [];
  let shellReads = 0;
  const activity = new ActivityLog(repoDir, { timeZone: 'Asia/Shanghai' });
  const releases = await new ReleaseStore(repoDir).load();
  const tutor = await new TutorStore(repoDir).load();
  const notes = await new NoteStore(configDir, { watch: false }).load();
  const agentCalls: RunStructuredOptions[] = [];
  // A fake login shell so tests never launch the user's real one.
  // What the fake login shell reports; tests can prepend a folder of fake CLIs.
  let shellPathPrefix = '/tp/shell/bin';
  const pathResolver = createPathResolver({
    inherited: '/usr/bin:/bin',
    read: async () => {
      shellReads += 1;
      return `${shellPathPrefix}:${process.env.PATH}`;
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
      appVersion: '9.9.9',
      requirements,
      activity,
      releases,
      tutor,
      notes,
      shell: {
        revealPath: async (dir) => {
          revealed.push(dir);
        },
        revealFile: (file) => void revealed.push(file),
        launchEditor: async (file, args) => void launched.push({ file, args }),
        pickDirectory: coding.pickDirectory,
      },
      agents: {
        runAgent: async (options) => {
          agentCalls.push(options);
          if (!agent) throw Object.assign(new Error('no agent in this test'), { code: 'agent_unavailable' });
          return (await agent(options)) as StructuredResult;
        },
        modelCatalog,
        // Never run the real CLIs from a test.
        probeAgent: coding.probeAgent ?? (async (config) => ({ command: config.cli, available: true, version: 'test', reason: null })),
        checkSignIn: coding.checkSignIn ?? (async () => ({ state: 'signed_in', source: 'test' })),
      },
      coding: {
        probe: coding.codingProbe,
        prepare: coding.codingPrepare,
        run: coding.codingRun,
        readPatch: coding.codingReadPatch,
        // Fake patches have no real blobs to merge: every file lands clean.
        previewMerge:
          coding.codingPreviewMerge ?? (async (_root, _baseline, files) => files.map((file) => ({ path: file.path, state: 'clean' as const, markers: false }))),
        applyPatch: coding.codingApplyPatch,
        clean: coding.codingClean,
        snapshot: coding.codingSnapshot,
      },
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
  // Must be called before anything reads the login shell, which is cached.
  const setShellPathPrefix = (next: string) => {
    shellPathPrefix = next;
  };
  return {
    setShellPathPrefix,
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
    notes,
    agentCalls,
    shellReads: () => shellReads,
    shutdown: () => ipc?.shutdown(),
  };
};

/** Polls until a requirement leaves a running state. */
export const settle = async (call, id) => {
  for (let i = 0; i < 200; i += 1) {
    const { data } = await call(CHANNELS.requirementsGet, id);
    if (data.status !== 'clarifying' && data.status !== 'planning') return data;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('requirement never settled');
};

export const codingRuntime = (overrides: Partial<CodingRuntimeStatus> = {}): CodingRuntimeStatus => ({
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
export const filePatch = (file: string, line: string, scope?: readonly string[]): CodingPatchPreview =>
  parsePatchPreview(`diff --git a/${file} b/${file}\nindex 1111111..2222222 100644\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-export {};\n+${line}\n`, scope);

export type TestCall = (channel: Channel, ...args: unknown[]) => Promise<IpcResult<unknown>>;
// Waits on wall-clock time, not event-loop turns: a round writes the store to
// disk several times, which a slow CI runner can take well over 100 ms to do.
export const SETTLE_TIMEOUT_MS = 5000;
export const settleCoding = async (call: TestCall, id: string): Promise<TaskView> => {
  let last = 'no response';
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const response = await call(CHANNELS.codingGet, id);
    if (response.ok) {
      const task = response.data as TaskView;
      last = JSON.stringify(task.codingRun);
      if (task.codingRun && ['ready', 'failed', 'cancelled', 'discarded'].includes(task.codingRun.status)) return task;
    } else last = JSON.stringify(response.error);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`coding run never settled: ${last}`);
};

export const CLARIFY_OUTPUT = { title: '邮箱登录', summary: '用户用邮箱和密码登录', questions: ['连续失败几次锁定？'] };
export const PLAN_OUTPUT = {
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
      mode: { mode: 'practice', reason: '能练到用例层怎么调用仓储。' },
    },
  ],
};
export const SUMMARY_OUTPUT = {
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
export const ADJUDICATE_REPLAN = {
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
export const stepOf = (schema) =>
  schema.properties.strengths
    ? 'grade'
    : schema.properties.hints
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
export const TUTOR_ANSWER = {
  explanation: '在测试文件里加一个用例，检查邮箱大小写不同也能登录。',
  hints: ['打开 tests/auth/login-user.test.ts', '仿照已有用例写一个新的 test()'],
  snippet: { language: 'ts', code: "test('email is case-insensitive', () => {\n  // ...\n});" },
  terms: [{ term: '用例', meaning: '一个独立的测试，检查一种情况。' }],
};

const GRADE_REPORT = {
  summary: '用例覆盖了大小写，写法清楚。',
  strengths: ['用例名直接说明了要验证的行为'],
  comments: [
    {
      category: 'writing',
      file: 'tests/auth/login-user.test.ts',
      line: 1,
      observation: '用例里没有断言。',
      betterWay: '加一个 expect，确认登录结果。',
      repeated: true,
    },
    { category: 'style', file: 'src/elsewhere.ts', line: 3, observation: '命名和周围不一致。', betterWay: '沿用现有的驼峰命名。', repeated: false },
  ],
};

/** A fake team answering by which schema it was given. */
export const fakeAgent =
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
      grade: () => overrides.grade ?? GRADE_REPORT,
    }[stepOf(schema)]();
    if (output instanceof Error) throw output;
    return { output, costUsd: 0.02 };
  };
export const callFor = (calls, step) => calls.find((c) => stepOf(c.schema) === step);

export const validPrefs = (overrides: Record<string, object> = {}) => ({
  profile: { displayName: 'Ada Lovelace', avatarColor: 'ocean', ...overrides.profile },
  appearance: { theme: 'dark', vibrancy: false, ...overrides.appearance },
  environment: { pathSource: 'inherit', ...overrides.environment },
  agents: preferences.defaults().agents,
  coding: { isolation: 'separate-user', extraRead: [], extraWrite: [], timeoutMinutes: 30, ...overrides.coding },
});

/* QA review */

export const EDGE_TESTS_PASS = {
  command: process.execPath,
  args: ['-e', "console.log('ok 1 - login is case-insensitive for the email\\nok 2 - account locks after five failed attempts')"],
};
export const QA_PASS = {
  verdict: 'pass',
  summary: '两个边界用例都已覆盖。',
  criteria: [
    { index: 0, status: 'met', note: '覆盖' },
    { index: 1, status: 'met', note: '覆盖' },
  ],
  issues: [],
};

/** Claims auth-edge-tests, writes its test file, and submits it. */
export const submitEdgeTests = async ({ call, root }) => {
  await call(CHANNELS.transition, 'auth-edge-tests', 'claim');
  await fs.mkdir(path.join(root, 'tests/auth'), { recursive: true });
  await fs.writeFile(path.join(root, 'tests/auth/login-user.test.ts'), 'test("case-insensitive", () => {});\n');
  return call(CHANNELS.transition, 'auth-edge-tests', 'submit_for_review');
};

/** Polls until the package's review leaves 'running'. */
export const settleReview = async (call, id) => {
  for (let i = 0; i < 400; i += 1) {
    const { data } = await call(CHANNELS.getTask, id);
    if (data.review?.status !== 'running') return data;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('review never settled');
};

export const ENV_PLAN = {
  summary: '无依赖项目，安装后即可运行测试。',
  install: { mode: 'install', reason: '没有 lockfile' },
  scripts: { test: 'test', lint: 'lint', build: '' },
  issues: [],
};

// Appends are not awaited by handlers; poll the overview until `count` events land.
export const overviewWith = async (call, count: number) => {
  for (let i = 0; i < 200; i += 1) {
    const { data } = await call(CHANNELS.activityOverview);
    if (data.recent.length >= count) return data;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`expected ${count} activity events`);
};

/* Tutor */

export const claimedState = { status: 'in_progress', baseline: null, claimedAt: null, completedSteps: [], deviations: [], review: null };

export const settleTutor = async (call, id, stepIndex) => {
  for (let i = 0; i < 200; i += 1) {
    const { data } = await call(CHANNELS.tutorGet, id, stepIndex);
    if (data.status !== 'running') return data;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('tutor never settled');
};

// Publishes a two-package plan where the second depends on the first.
export const publishChain = async (h: Awaited<ReturnType<typeof harness>>) => {
  h.agentCalls.length = 0;
  const { data } = await h.call(CHANNELS.requirementsCreate, { text: '用户可以用邮箱登录' });
  await settle(h.call, data.id);
  await h.call(CHANNELS.requirementsPlan, data.id, ['5 次']);
  await settle(h.call, data.id);
  await h.call(CHANNELS.requirementsPublish, data.id);
  return { first: `${data.id}-wp1`, second: `${data.id}-wp2` };
};

// A repository course pack (src/main/courses.ts), for the tests that switch packs.
export const OS_PACK = `
schemaVersion = 1
id = "oslab"
version = "0.1.0"
domain = "operating-systems"
title = "操作系统实验"
summary = "在教学内核里动手。"
learner = "a student learning operating systems"
tutorGuide = ["Connect every step to the mechanism behind it."]
difficultyGuide = ["- easy: uses an existing kernel facility."]
practiceGuide = ["- practice: the core mechanism of the lab."]
referenceGuide = "Write the complete solution to this lab step."

[[rubric]]
id = "concept"
label = "原理"
dimension = "thinking"
description = "the model of the mechanism"

[[rubric]]
id = "mechanism"
label = "实现"
dimension = "writing"
description = "locking and error paths"
`;

// Selects OS_PACK in taskpilot.toml and, unless `confirm` is false, confirms it on this machine.
export const useOsPack = async ({ call, root }: Pick<Awaited<ReturnType<typeof harness>>, 'call' | 'root'>, { confirm = true } = {}) => {
  await fs.writeFile(path.join(root, 'taskpilot.toml'), 'course = "oslab"\n');
  await fs.mkdir(path.join(root, '.taskpilot/courses'), { recursive: true });
  await fs.writeFile(path.join(root, '.taskpilot/courses/oslab.toml'), OS_PACK);
  const { data } = await call(CHANNELS.workspaceGet);
  const shown = data.course.state.ref;
  if (confirm) await call(CHANNELS.workspaceConfirmCourse, 'oslab', shown.contentHash);
  return shown;
};
