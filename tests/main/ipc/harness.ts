// Shared by the IPC tests: a registered app over a temporary git repository
// and deterministic waits for background runs.
import { onTestFinished } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { registerIpcHandlers } from '../../../src/main/ipc.ts';
import type { IpcHandle } from '../../../src/main/ipc.ts';
import type { AgentDeps, ShellDeps } from '../../../src/main/app/app_context.ts';
import type { CodingDeps } from '../../../src/main/coding/coding_runtime.ts';
import type { Grader } from '../../../src/main/courses/lab_verify.ts';
import type { IpcResult } from '../../../src/shared/ipc/envelope.ts';
import type { TaskView } from '../../../src/shared/ipc/packages.ts';
import type { CodingPatchPreview, CodingRuntimeStatus } from '../../../src/shared/coding_types.ts';
import { parsePatchPreview } from '../../../src/main/coding/coding_workspace.ts';
import type { RunStructuredOptions, StructuredResult } from '../../../src/main/runtimes/claude_cli.ts';
import type { Channel } from '../../../src/shared/ipc_channels.ts';
import { CHANNELS } from '../../../src/shared/ipc_channels.ts';
import { buildApi } from '../../../src/shared/ipc/contract.ts';
import { CONTRACTS } from '../../../src/shared/ipc/contracts.ts';
import type { ContractApi } from '../../../src/shared/ipc/contracts.ts';
import { WorkPackageStore } from '../../../src/main/work_packages/work_package_store.ts';
import { SAMPLE_REQUIREMENT } from '../fixtures/sample_tasks.ts';
import { REQUIREMENTS_FILENAME, RequirementStore } from '../../../src/main/requirements/requirement_store.ts';
import { ActivityLog } from '../../../src/main/activity/activity_log.ts';
import { ReleaseStore } from '../../../src/main/release/release_store.ts';
import { STATE_FILENAME } from '../../../src/main/work_packages/work_package_store.ts';
import * as workspace from '../../../src/main/repository/workspace.ts';
import * as preferences from '../../../src/main/app/preferences.ts';
import { createPathResolver } from '../../../src/main/infrastructure/shell_env.ts';
import { RepositoryRegistry } from '../../../src/main/repository/repositories.ts';
import { TutorStore } from '../../../src/main/work_packages/tutor_store.ts';
import { NoteStore } from '../../../src/main/notes/note_store.ts';
import { MasteryStore } from '../../../src/main/courses/mastery_store.ts';
import { BUILTIN } from '../../fixtures/builtin_courses.ts';

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
  pickFile?: ShellDeps['pickFile'];
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
  labGrader = undefined,
}: {
  withRepo?: boolean;
  agent?: FakeAgent | null;
  seedState?: Record<string, unknown> | null;
  coding?: CodingOverrides;
  modelCatalog?: AgentDeps['modelCatalog'];
  // The lab self-check's `make grade`; the real one runs only under Seatbelt.
  labGrader?: Grader;
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
  const mastery = await new MasteryStore(configDir).load();
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
      builtinCourses: BUILTIN,
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
      mastery,
      shell: {
        revealPath: async (dir) => {
          revealed.push(dir);
        },
        revealFile: (file) => void revealed.push(file),
        launchEditor: async (file, args) => void launched.push({ file, args }),
        pickDirectory: coding.pickDirectory,
        pickFile: coding.pickFile,
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
      labGrader,
    },
  );

  // Untyped, for the tests that send malformed arguments on purpose.
  const call = (channel: Channel, ...args: unknown[]) => handlers.get(channel)!({}, ...args);
  idleByCall.set(call, () => ipc!.idle());
  // Typed from the contract tables, as the renderer calls it; no events reach it.
  const api: ContractApi = buildApi(CONTRACTS, {
    invoke: async (channel, ...args) => call(channel as Channel, ...args),
    on: () => undefined,
    removeListener: () => undefined,
  });
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
    api,
    // Every channel registered, for the contract coverage test.
    channels: () => [...handlers.keys()],
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
    mastery,
    agentCalls,
    // The lab service main-process callers use (src/main/courses/lab_service.ts).
    labs: ipc.labs,
    // The first lab's generation (src/main/courses/lab_generation_service.ts).
    labGeneration: ipc.labGeneration,
    shellReads: () => shellReads,
    idle: () => ipc!.idle(),
    shutdown: () => ipc?.shutdown(),
  };
};

const idleByCall = new WeakMap<object, () => Promise<void>>();

export const until = async <Value>(read: () => Promise<Value>, done: (value: Value) => boolean, label: string): Promise<Value> => {
  const deadline = Date.now() + 5000;
  let last: Value | undefined;
  while (Date.now() < deadline) {
    last = await read();
    if (done(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`${label} timed out; last value: ${JSON.stringify(last)}`);
};

/** Waits until a requirement leaves a running state. */
export const settle = async (call, id) => {
  await idleByCall.get(call)?.();
  return (await call(CHANNELS.requirementsGet, id)).data;
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
// A coding run writes the store several times before its promise settles.
export const settleCoding = async (call: TestCall, id: string): Promise<TaskView> => {
  await idleByCall.get(call)?.();
  const response = await call(CHANNELS.codingGet, id);
  if (!response.ok) throw new Error(`coding run lookup failed: ${response.error.code}`);
  return response.data as TaskView;
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
    : schema.properties.differences
      ? 'differences'
      : schema.properties.replies
        ? 'feedback'
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

export const DIFFERENCES_OUTPUT = {
  differences: [
    { category: 'thinking', file: 'tests/auth/login-user.test.ts', difference: '参考实现先写了一个会失败的用例。' },
    { category: 'writing', file: 'src/not-in-reference.ts', difference: '参考实现把断言放在了一处。' },
  ],
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
      // A grade without levels gets level 3 on every rubric item the schema asks for.
      grade: () => {
        const report = overrides.grade ?? GRADE_REPORT;
        if (report instanceof Error || 'levels' in (report as object)) return report;
        return { ...report, levels: Object.fromEntries(schema.properties.levels.required.map((id) => [id, 3])) };
      },
      differences: () => overrides.differences ?? DIFFERENCES_OUTPUT,
      feedback: () =>
        overrides.feedback ?? {
          replies: Array.from({ length: schema.properties.replies.minItems }, (_, index) => ({
            correct: index === 0,
            missed: index === 0 ? null : '没提到断言要集中。',
          })),
        },
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
  await call(CHANNELS.packagesTransition, 'auth-edge-tests', 'claim');
  await fs.mkdir(path.join(root, 'tests/auth'), { recursive: true });
  await fs.writeFile(path.join(root, 'tests/auth/login-user.test.ts'), 'test("case-insensitive", () => {});\n');
  return call(CHANNELS.packagesTransition, 'auth-edge-tests', 'submit_for_review');
};

/** Waits until the package's review has finished. */
export const settleReview = async (call, id) => {
  await idleByCall.get(call)?.();
  return (await call(CHANNELS.tasksGet, id)).data;
};

export const ENV_PLAN = {
  summary: '无依赖项目，安装后即可运行测试。',
  install: { mode: 'install', reason: '没有 lockfile' },
  scripts: { test: 'test', lint: 'lint', build: '' },
  issues: [],
};

// Store appends are complete after the background registry and store queues idle.
export const overviewWith = async (call, count: number) => {
  await idleByCall.get(call)?.();
  const overview = (await call(CHANNELS.activityOverview)).data;
  if (overview.recent.length < count) throw new Error(`expected ${count} activity events, got ${overview.recent.length}`);
  return overview;
};

/* Tutor */

export const claimedState = { status: 'in_progress', baseline: null, claimedAt: null, completedSteps: [], deviations: [], review: null };

export const settleTutor = async (call, id, stepIndex) => {
  await idleByCall.get(call)?.();
  return (await call(CHANNELS.tutorGet, id, stepIndex)).data;
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

// A repository course pack (src/main/courses/courses.ts), for the tests that switch packs.
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
