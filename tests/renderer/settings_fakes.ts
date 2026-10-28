// Shared fakes for the settings and setup tests: builders and their
// installFakeApi() defaults: every other call rejects as not faked.
import { AGENT_IDS, defaultAgentSettings } from '@shared/agent_runtime.ts';
import type * as masteryTypes from '@shared/ipc/mastery.ts';
import type * as agentRuntimeTypes from '@shared/agent_runtime.ts';
import type * as settingsTypes from '@shared/ipc/settings.ts';
import type * as workspaceTypes from '@shared/ipc/workspace.ts';
import type * as courseTypes from '@shared/ipc/courses.ts';
import type * as envTypes from '@shared/ipc/environment.ts';
import type { CoursePack } from '@shared/course_pack.ts';
import { BUILTIN_COURSES, OS_COURSE } from '../fixtures/builtin_courses.ts';
import { STEP_KINDS } from '@shared/check_steps.ts';
import { installFakeApi, ok } from './ipc_fakes.ts';
import type { Overrides } from './ipc_fakes.ts';

// Tests import the envelope helpers beside the fixtures.
export { fail, ok } from './ipc_fakes.ts';

export const preferences = (): settingsTypes.Preferences => ({
  profile: { displayName: 'Ada', avatarColor: 'ocean', initials: 'A' },
  appearance: { theme: 'system', vibrancy: false },
  environment: { pathSource: 'inherit' },
  agents: defaultAgentSettings(),
  coding: { isolation: 'sandbox', extraRead: [], extraWrite: [], timeoutMinutes: 30 },
});

// A step this machine sets to `lines`, or one left to the project ([]).
const stepView = (id: workspaceTypes.CheckKind, lines: string[] = []): workspaceTypes.StepView => {
  const form = {
    enabled: true,
    lines,
    cwd: '',
    stage: id === 'test' ? 'submit' : 'step',
    blocking: id === 'test',
    parser: { format: 'tests' },
    timeoutSeconds: null,
  } as const;
  return {
    id,
    label: null,
    effective: lines.length ? form : null,
    source: lines.length ? 'local' : null,
    skipped: lines.length ? null : 'not_configured',
    local: lines.length ? form : null,
    suggestions: id === 'lint' ? ['npm run lint'] : [],
  };
};

// The built-in pack in use, as workspace:get reports it with nothing set.
export const defaultCourse = (): workspaceTypes.CourseView => ({
  selected: { id: 'programming', from: 'default' },
  available: [{ id: 'programming', source: 'builtin' }],
  state: { status: 'ok' },
  ref: { id: 'programming', version: '1.0.0', contentHash: 'a'.repeat(64), source: 'builtin' },
});

// courses:list with only the built-in packs, programming in use.
export const courseList = (overrides: Partial<courseTypes.CourseList> = {}): courseTypes.CourseList => ({
  current: defaultCourse(),
  entries: [
    { id: 'programming', source: 'builtin', title: '编程', version: '1.0.0', languages: null, trust: 'builtin', error: null },
    { id: 'os', source: 'builtin', title: '操作系统实验', version: '0.1.0', languages: ['c', 'rust'], trust: 'builtin', error: null },
  ],
  languages: ['typescript'],
  userDir: '/config/courses',
  ...overrides,
});

export const coursePreview = (id: string, overrides: Partial<courseTypes.CoursePreview> = {}): courseTypes.CoursePreview => {
  const pack = BUILTIN_COURSES.find((entry) => entry.id === id) ?? { ...OS_COURSE, id, title: `${id} 课程` };
  const source = BUILTIN_COURSES.includes(pack) ? 'builtin' : 'repository';
  return {
    pack,
    ref: { id, version: pack.version, contentHash: 'b'.repeat(64), source },
    trust: source === 'builtin' ? 'builtin' : 'pending',
    previous: 'none',
    changes: [],
    ...overrides,
  };
};

// courses:copy / courses:save: `id` written into the global folder, pending.
export const courseSaved = (id: string, pack: CoursePack = { ...OS_COURSE, id }): courseTypes.CourseSaved => {
  const ref = { id, version: pack.version, contentHash: 'c'.repeat(64), source: 'user' as const };
  const entry: courseTypes.CourseEntry = { id, source: 'user', title: pack.title, version: pack.version, languages: null, trust: 'pending', error: null };
  return {
    list: courseList({ entries: [...courseList().entries, entry] }),
    preview: { pack, ref, trust: 'pending', previous: 'none', changes: [] },
  };
};

const workspaceView = (overrides: Partial<workspaceTypes.WorkspaceView> = {}): workspaceTypes.WorkspaceView => ({
  root: '/repo',
  steps: STEP_KINDS.map((id) => stepView(id, id === 'test' ? ['npm test'] : [])),
  project: { status: 'missing' },
  course: defaultCourse(),
  detected: [{ manifest: 'package.json', language: 'TypeScript / JavaScript', preset: 'typescript' }],
  presets: [{ id: 'typescript', label: 'TypeScript / JavaScript' }],
  ...overrides,
});

const workspaceCheck = (): workspaceTypes.WorkspaceCheck => ({
  root: '/repo',
  repo: { commit: 'abcdef1234567890', branch: 'main', dirty: false, changedFiles: 0 },
  steps: Object.fromEntries(
    STEP_KINDS.map((id) => [id, id === 'test' ? { configured: true, resolved: '/usr/local/bin/npm' } : { configured: false, resolved: null }]),
  ),
  tools: [],
});

export const envState = (overrides: Partial<envTypes.EnvState> = {}): envTypes.EnvState => ({
  root: '/repo',
  status: 'ready',
  stale: false,
  facts: {
    manifest: { valid: true, name: 'app', scripts: { test: 'vitest' }, engines: {}, packageManager: null },
    lockfiles: ['package-lock.json'],
    managers: ['npm'],
    nodeModules: false,
    versionFiles: [],
    workflows: [],
    tools: { node: 'v22.0.0', npm: '10.0.0' },
    installScripts: [],
  },
  blockers: [],
  plan: {
    summary: '先安装依赖再跑测试。',
    install: 'ci',
    installReason: '有 lockfile',
    scripts: { test: 'test', lint: null, build: null },
    issues: [],
    adjustments: [],
  },
  error: null,
  costUsd: 0,
  allowScripts: false,
  running: null,
  live: null,
  steps: [
    { id: 'install', kind: 'install', script: null, packages: [], replacesInstall: false, line: 'npm ci --ignore-scripts', result: null },
    { id: 'test', kind: 'test', script: 'test', packages: [], replacesInstall: false, line: 'npm run test', result: null },
  ],
  stepKinds: ['test', 'lint', 'build'],
  configured: { test: '', lint: '', build: '' },
  ...overrides,
});

// `overrides` replace whole namespaces of the defaults below.
export const installApi = (overrides: Overrides = {}) => {
  let savedPreferences = preferences();
  return installFakeApi({
    tasks: { list: () => ok([]) },
    workspace: {
      get: () => ok(workspaceView()),
      set: (form: workspaceTypes.WorkspaceForm) =>
        ok(
          workspaceView({
            root: form.root,
            steps: STEP_KINDS.map((id) => {
              const step = form.steps[id];
              return step ? { ...stepView(id, step.lines), local: step } : stepView(id);
            }),
          }),
        ),
      check: () => ok(workspaceCheck()),
      createProject: (preset: string) => ok(workspaceView({ project: { status: 'ok', preset } })),
      confirmCourse: () => ok(workspaceView()),
      pickRoot: () => ok(null),
      info: () => ok({ configured: false }),
    },
    courses: {
      list: () => ok(courseList()),
      preview: (id: string) => ok(coursePreview(id)),
      select: () => ok(courseList()),
      pickImport: () => ok<courseTypes.CourseImport | null>(null),
      import: () => ok(courseList()),
      default: () => ok(BUILTIN_COURSES[0]),
      copy: (_sourceId: string, id: string) => ok(courseSaved(id)),
      save: (id: string) => ok(courseSaved(id)),
    },
    preferences: {
      get: () => ok(savedPreferences),
      set: (input: settingsTypes.PreferencesInput) => {
        savedPreferences = { ...input, profile: { ...input.profile, initials: 'X' } };
        return ok(savedPreferences);
      },
    },
    agent: {
      runtimes: () =>
        ok(AGENT_IDS.map((agent) => ({ agent, config: defaultAgentSettings()[agent], command: 'claude', available: true, version: '1.0', reason: null }))),
      models: (request: agentRuntimeTypes.CliModelsRequest) =>
        ok<agentRuntimeTypes.CliModelCatalog>({
          cli: request.cli,
          scope: request.scope,
          models:
            request.cli === 'pi'
              ? [{ id: 'gateway/native-model', label: 'Native Pi model', provider: 'gateway', variants: ['high'], source: 'config' }]
              : request.cli === 'opencode'
                ? [{ id: 'gateway/opencode-model', label: 'Native OpenCode model', provider: 'gateway', variants: ['high', 'low'], source: 'config' }]
                : [{ id: 'native-default', label: 'Native default model', provider: null, variants: [], source: 'config' }],
          defaultModel: request.cli === 'pi' ? 'gateway/native-model' : 'native-default',
          defaultThinking: null,
          issues: [],
        }),
    },
    environment: {
      info: () =>
        ok({
          requested: 'inherit',
          source: 'inherit',
          error: null,
          shell: '/bin/zsh',
          entries: ['/usr/bin'],
          inheritedCount: 1,
          platform: 'darwin',
          versions: { app: '0.1.0', electron: '40', node: '22' },
        }),
    },
    data: {
      info: () => ok({ configDir: '/config', files: ['workspace.json'], packages: { total: 3, claimed: 1, deviations: 0 } }),
      resetProgress: () => ok({ total: 3, claimed: 0, deviations: 0 }),
      reveal: () => ok(true),
    },
    // The 课程 view's mastery summary; no lab repository and nothing attempted.
    mastery: {
      course: (id = 'programming') => ok<masteryTypes.CourseMastery>({ course: { id, title: `${id} 课程` }, concepts: [], errorTypes: [], repositories: [] }),
    },
    env: {
      get: () => ok(envState()),
      plan: () => ok(envState()),
      setAllowScripts: (allow: boolean) => ok(envState({ allowScripts: allow })),
      runStep: () => ok(envState()),
      apply: () => ok(envState()),
      cancel: () => ok(true),
    },
    ...overrides,
  });
};
