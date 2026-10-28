// Shared fakes for the requirement center tests: a requirement builder and its
// installFakeApi() defaults: every other call rejects as not faked.

import type * as packageTypes from '../../src/shared/ipc/packages.ts';
import type * as releaseTypes from '../../src/shared/ipc/release.ts';
import type * as requirementTypes from '../../src/shared/ipc/requirements.ts';
import type * as settingsTypes from '../../src/shared/ipc/settings.ts';
import type * as workspaceTypes from '../../src/shared/ipc/workspace.ts';
import { defaultCourse } from './settings_fakes.ts';
import type { PathEntry } from '../../src/shared/course_plan.ts';
import { installFakeApi, ok } from './ipc_fakes.ts';

export const requirement = (overrides: Partial<requirementTypes.Requirement> = {}): requirementTypes.Requirement => ({
  id: 'r1',
  status: 'answering',
  title: '邮箱登录',
  text: '用户可以用邮箱登录。',
  summary: null,
  questions: [],
  plan: null,
  packages: [],
  interfaces: null,
  phase: null,
  error: null,
  failedStep: null,
  costUsd: 0,
  createdAt: '2026-01-02T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  ...overrides,
});

export const planPackage = (overrides: Partial<requirementTypes.PlanPackage> = {}): requirementTypes.PlanPackage => ({
  title: '登录接口',
  description: '实现邮箱登录',
  module: 'auth',
  tags: ['auth', 'api'],
  priority: 'high',
  estimateHours: 1.5,
  icon: 'key',
  steps: ['新增 `login()`'],
  fileScope: ['src/auth.ts'],
  acceptance: [{ text: '登录成功', test: 'login works' }],
  difficulty: { level: 'easy', reason: '照着现有代码改一个文件。' },
  ...overrides,
});

// ========== Course interview ==========
const concept = (id: string, label: string, prerequisites: string[] = []) => ({ id, label, summary: `${label}。`, prerequisites });
const PATH_CONCEPTS = [concept('process-state', '进程状态'), concept('fcfs', '先来先服务', ['process-state']), concept('round-robin', '时间片轮转', ['fcfs'])];

export const courseInterview = (overrides: Partial<requirementTypes.CourseInterview> = {}): requirementTypes.CourseInterview => ({
  form: { level: 'basic', target: 'implement', environment: 'macOS', weeklyHours: 4 },
  pick: { course: 'os', reason: 'os 包的骨架覆盖调度。', options: [{ id: 'os', title: '操作系统实验' }] },
  choice: null,
  plan: null,
  pathConcepts: [],
  draft: null,
  ...overrides,
});

export const coursePathInterview = (
  path: PathEntry[] = [
    { conceptId: 'process-state', status: 'known' },
    { conceptId: 'fcfs', status: 'planned' },
    { conceptId: 'round-robin', status: 'planned' },
  ],
): requirementTypes.CourseInterview =>
  courseInterview({
    choice: { course: 'os' },
    pathConcepts: PATH_CONCEPTS,
    plan: {
      course: { id: 'os', version: '0.2.0', contentHash: 'h', source: 'builtin' },
      goal: { kind: 'course', goal: '调度', level: 'basic', target: 'implement', environment: 'macOS', weeklyHours: 4, knownConcepts: ['process-state'] },
      summary: '从进程状态到时间片轮转。',
      path,
      extraConcepts: [],
    },
  });

// Installs window.taskpilot; `list` is what requirements.list() returns now.
// ========== First lab ==========
const LAB_ESTIMATE: requirementTypes.LabEstimate = {
  concepts: [{ id: 'round-robin', label: '时间片轮转' }],
  difficulty: 'easy',
  change: 'kept',
  stuck: null,
  calls: 4,
  maxCalls: 10,
  tokens: { input: 30000, output: 26000 },
  model: 'claude-opus-5-5',
  usd: { low: 0.42, high: 1.35 },
};

export const labGeneration = (overrides: Partial<requirementTypes.LabGeneration> = {}): requirementTypes.LabGeneration => ({
  status: 'ready',
  phase: null,
  concepts: ['round-robin'],
  difficulty: 'easy',
  startedAt: '2026-01-02T00:00:00.000Z',
  finishedAt: '2026-01-02T00:02:00.000Z',
  costUsd: 1.2,
  lab: {
    id: 'round-robin',
    title: '时间片轮转调度',
    summary: '用就绪队列按时间片轮流运行作业。',
    estimateHours: 2,
    starterFiles: 1,
    publicTests: 3,
    hiddenTests: 5,
  },
  error: null,
  ...overrides,
});

export const installApi = (state: { list: requirementTypes.Requirement[] }) =>
  installFakeApi({
    requirements: {
      list: () => ok(state.list),
      create: (input: requirementTypes.RequirementInput) => ok(requirement({ id: 'new', status: 'clarifying', title: input.title ?? '', text: input.text })),
      clarify: (id: string) => ok(requirement({ id, status: 'clarifying' })),
      answer: (id: string) => ok(requirement({ id, status: 'answering' })),
      plan: (id: string) => ok(requirement({ id, status: 'planning' })),
      publish: (id: string) =>
        ok(requirement({ id, status: 'published', plan: { summary: 's', packages: [planPackage()] }, packages: [{} as packageTypes.TaskDefinition] })),
      remove: () => ok(true as const),
      cancel: () => ok(true),
      coursePath: (id: string, path: PathEntry[]) => ok(requirement({ id, kind: 'course', status: 'reviewing', course: coursePathInterview(path) })),
      courseSaveDraft: (id: string) =>
        ok<requirementTypes.CourseDraftSaved>({
          requirement: requirement({ id, kind: 'course', status: 'reviewing', course: { ...courseInterview(), choice: { course: 'lexing' } } }),
          ref: { id: 'lexing', version: '0.1.0', contentHash: 'saved-hash', source: 'user' },
        }),
      courseConfirmDraft: (id: string) =>
        ok(requirement({ id, kind: 'course', status: 'reviewing', course: { ...courseInterview(), choice: { course: 'lexing' } } })),
      labEstimate: () => ok(LAB_ESTIMATE),
      labGenerate: (id: string) =>
        ok(
          requirement({
            id,
            kind: 'course',
            status: 'published',
            course: { ...coursePathInterview(), lab: labGeneration({ status: 'running', phase: 'spec' }) },
          }),
        ),
      labPlace: (id: string) =>
        ok(
          requirement({
            id,
            kind: 'course',
            status: 'published',
            course: { ...coursePathInterview(), lab: labGeneration({ stage: 1, placed: true }), repositoryId: 'lab-repo' },
          }),
        ),
    },
    repositories: {
      list: () => ok({ current: 'lab-repo', repositories: [] }),
      busy: () => ok([]),
    },
    // MilestonePicker loads the release state when a requirement detail mounts.
    release: {
      get: () => ok<releaseTypes.ReleaseState>({ configured: false, draft: null, milestones: [], history: [], startPoint: null, running: false }),
    },
    agent: { status: () => ok<settingsTypes.AgentStatus>(agentStatus()) },
    workspace: {
      pickRoot: () => ok<string | null>('/Users/me/sched-lab'),
      info: () => ok({ configured: false } as workspaceTypes.WorkspaceInfo),
      get: () =>
        ok({ root: null, steps: [], project: { status: 'missing' }, course: defaultCourse(), detected: [], presets: [] } as workspaceTypes.WorkspaceView),
    },
    tasks: { list: () => ok([]) },
  });

// agent:status for a ready machine: analysis CLI signed in, coding CLI installed and signed in.
export const agentStatus = (overrides: Partial<settingsTypes.AgentStatus> = {}): settingsTypes.AgentStatus => ({
  available: true,
  command: 'claude',
  signIn: { state: 'signed_in', source: 'claude auth status' },
  coding: { cli: 'codex', installed: true, signIn: { state: 'signed_in', source: 'codex login status' } },
  ...overrides,
});
