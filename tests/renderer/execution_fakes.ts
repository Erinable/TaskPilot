// Shared fakes for the execution view tests: a TaskView builder and its
// installFakeApi() defaults: every other call rejects as not faked.

import type * as codingTypes from '../../src/shared/coding_types.ts';
import type * as noteTypes from '../../src/shared/ipc/notes.ts';
import type * as packageTypes from '../../src/shared/ipc/packages.ts';
import type * as tutorTypes from '../../src/shared/ipc/tutor.ts';
import type * as workspaceTypes from '../../src/shared/ipc/workspace.ts';
import { defaultCourse } from './settings_fakes.ts';
import { installFakeApi, ok } from './ipc_fakes.ts';
import { PROGRAMMING_COURSE } from '../fixtures/builtin_courses.ts';

export const taskView = (overrides: Partial<packageTypes.TaskView> = {}): packageTypes.TaskView => ({
  id: 't1',
  status: 'in_progress',
  statusLabel: '执行中',
  title: '邮箱登录',
  description: '实现邮箱登录',
  intro: '让用户用邮箱登录。',
  module: 'auth',
  tags: ['auth'],
  priority: 'high',
  estimate: '2h',
  icon: 'key',
  steps: ['新增 `login()`', '写测试'],
  fileScope: ['src/auth.ts'],
  acceptance: [{ text: '登录成功', test: 'login works' }],
  baseline: 'abcdef1234567890',
  claimedAt: '2026-01-02T00:00:00.000Z',
  completedSteps: [],
  deviations: [],
  review: null,
  codingRun: null,
  mode: null,
  referenceRun: null,
  referenceLock: null,
  grade: null,
  baselineChecks: { status: 'measured', reason: null, commit: 'abcdef12', checks: {}, startedAt: '', finishedAt: null },
  adjudication: null,
  revision: null,
  humanTransitions: [],
  dependencies: [],
  completedAt: null,
  ...overrides,
});

const state = (task: packageTypes.TaskView): packageTypes.WorkPackageState => ({
  status: task.status,
  baseline: task.baseline,
  claimedAt: task.claimedAt,
  completedSteps: task.completedSteps,
  deviations: task.deviations,
  review: task.review,
  baselineChecks: task.baselineChecks,
  revision: null,
  adjudication: task.adjudication,
  replanUndo: null,
  codingRun: task.codingRun,
  mode: task.mode,
  referenceRun: task.referenceRun,
  grade: task.grade,
  hints: [],
  snippetCopies: 0,
});

// A repository whose only check is a local `npm test` submit step.
export const testStepWorkspace = (root: string): workspaceTypes.WorkspaceView => ({
  root,
  steps: [
    {
      id: 'test',
      label: null,
      effective: { lines: ['npm test'], cwd: '', stage: 'submit', blocking: true, parser: { format: 'tests' }, timeoutSeconds: null },
      source: 'local',
      skipped: null,
      local: null,
      suggestions: [],
    },
  ],
  project: { status: 'missing' },
  course: defaultCourse(),
  detected: [],
  presets: [],
});

// Installs window.taskpilot; `task` is what getTask() returns now.
export const installApi = (current: { task: packageTypes.TaskView }) => {
  return installFakeApi({
    commit: {
      preview: () => ok({ files: ['src/auth.ts'], skipped: [{ path: 'notes.md', reason: 'out_of_scope' }], message: '邮箱登录\n\nTaskPilot 工作包 t1' }),
      create: (_id, _message, files) => ok({ commit: 'c0ffee1234', files }),
    },
    tasks: { list: () => ok([current.task]), get: () => ok(current.task) },
    packages: {
      transition: (_id: string, _name: packageTypes.HumanTransition, _options?: packageTypes.TransitionOptions) => ok(state(current.task)),
      waiveDependency: (_id: string, dependency: string) =>
        ok({
          ...current.task,
          dependencies: current.task.dependencies.map((entry) => (entry.id === dependency ? { ...entry, waived: true, blocking: false } : entry)),
        }),
      measureBaseline: () => ok(current.task),
      setStepDone: (_id: string, stepIndex: number) => ok(state({ ...current.task, completedSteps: [stepIndex] })),
    },
    review: { retry: () => ok(state(current.task)), cancel: () => ok(true) },
    deviation: { retry: () => ok(state(current.task)), cancel: () => ok(true) },
    diff: {
      stat: () => ok<workspaceTypes.DiffStat>({ changes: [], scope: { inScope: [], outOfScope: [], untouched: current.task.fileScope } }),
      file: () => ok(''),
    },
    coding: {
      status: () =>
        ok<codingTypes.CodingRuntimeStatus>({
          backend: 'codex',
          protocol: 'codex-exec',
          boundary: 'separate-user',
          available: true,
          version: 'test',
          reason: null,
          config: { user: 'coding-agent', cli: 'codex', model: 'test-model', thinking: 'default', timeoutMinutes: 30 },
        }),
      start: (_id: string, _input: codingTypes.CodingStart) => ok(current.task),
      get: () => ok(current.task),
      events: (_id: string, _after: number) => ok<codingTypes.CodingEventPage>({ events: [], next: -1, truncated: false }),
      cancel: () => ok(true),
      patch: () => ok<codingTypes.CodingPatchPreview>({ digest: 'test-digest', files: [], patch: '', blocked: [] }),
      apply: (_id: string, _input: codingTypes.CodingApply) => ok<codingTypes.CodingApplyResult>({ files: [], markers: [], kept: [] }),
      active: () => ok<codingTypes.CodingActiveRun[]>([]),
      resume: (_id: string) => ok(current.task),
    },
    workspace: {
      info: () => ok<workspaceTypes.WorkspaceInfo>({ configured: false }),
      openFile: () => ok<workspaceTypes.OpenedWith>('vscode'),
      get: () => ok(testStepWorkspace('/repo')),
    },
    notes: {
      list: () => ok<noteTypes.NoteList>({ revision: 1, directory: '/notes', custom: false, unavailable: null, truncated: false, notes: [] }),
      create: (input: noteTypes.NoteInput) =>
        ok<noteTypes.NoteSaved>({
          revision: 2,
          relinked: 0,
          note: {
            ...input,
            course: input.course ?? null,
            concepts: input.concepts ?? [],
            id: `${input.title}.md`,
            inlineTags: [],
            summary: null,
            summaryStale: false,
            links: [],
            excerpt: '',
            createdAt: '',
            updatedAt: '',
            version: 'v1',
            frontmatterError: false,
          },
        }),
      remove: () => ok(true),
    },
    practice: {
      reference: () => ok('diff --git a/src/auth.ts b/src/auth.ts\n+export const login = () => true;\n'),
      grade: (_id: string, _skipReference: boolean) => ok(current.task),
      explain: (_id: string) => ok(current.task),
      answer: (_id: string, _answers: (string | null)[]) => ok(current.task),
      saveExplanation: (_id: string) => ok(current.task),
    },
    courses: { default: () => ok(PROGRAMMING_COURSE) },
    tutor: {
      get: () => ok<tutorTypes.TutorState>({ status: 'idle', levels: [], pending: null, opened: 0, maxLevel: 5, error: null }),
      ask: (_id: string, _stepIndex: number, level: number) =>
        ok<tutorTypes.TutorState>({ status: 'running', levels: [], pending: level, opened: level - 1, maxLevel: 5, error: null }),
      copied: () => ok(1),
      cancel: () => ok(true),
    },
  });
};

// A Coding Agent round, ready for review unless overridden.
export const codingRun = (overrides: Partial<codingTypes.CodingRun> = {}): codingTypes.CodingRun => {
  const status = overrides.status ?? 'ready';
  return {
    id: 'run-1',
    packageId: 't1',
    runName: 'run',
    baseline: 'abcdef',
    status,
    user: 'coding-agent',
    model: 'test',
    cli: 'codex',
    thinking: 'default',
    runtimeVersion: '1',
    sessionId: null,
    instruction: '实现登录',
    startedAt: '',
    finishedAt: null,
    error: null,
    output: '',
    usage: { inputTokens: null, outputTokens: null, cachedInputTokens: null, reasoningTokens: null, costUsd: null },
    files: [],
    blocked: [],
    checks: {},
    patchDigest: status === 'ready' ? 'digest' : null,
    attempt: 1,
    trigger: 'human',
    feedback: null,
    halt: null,
    rounds: [],
    ...overrides,
  };
};
