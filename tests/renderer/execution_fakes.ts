// Shared fakes for the execution view tests: a TaskView builder and a
// window.taskpilot stub whose calls resolve {ok: true, data}.
import { vi } from 'vitest';

import type * as codingTypes from '../../src/shared/coding_types.ts';
import type * as noteTypes from '../../src/shared/ipc/notes.ts';
import type * as packageTypes from '../../src/shared/ipc/packages.ts';
import type * as tutorTypes from '../../src/shared/ipc/tutor.ts';
import type * as workspaceTypes from '../../src/shared/ipc/workspace.ts';
import { defaultCourse } from './settings_fakes.ts';
import { fakeApi, ok } from './ipc_fakes.ts';
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

export const state = (task: packageTypes.TaskView): packageTypes.WorkPackageState => ({
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

// Installs window.taskpilot; `task` is what getTask() returns now.
export const installApi = (current: { task: packageTypes.TaskView }) => {
  const api = {
    listTasks: vi.fn(() => ok([current.task])),
    getTask: vi.fn(() => ok(current.task)),
    transition: vi.fn((_id: string, _name: packageTypes.HumanTransition, _options?: packageTypes.TransitionOptions) => ok(state(current.task))),
    waiveDependency: vi.fn((_id: string, dependency: string) =>
      ok({
        ...current.task,
        dependencies: current.task.dependencies.map((entry) => (entry.id === dependency ? { ...entry, waived: true, blocking: false } : entry)),
      }),
    ),
    measureBaseline: vi.fn(() => ok(current.task)),
    setStepDone: vi.fn((_id: string, stepIndex: number) => ok(state({ ...current.task, completedSteps: [stepIndex] }))),
    review: { retry: vi.fn(() => ok(state(current.task))), cancel: vi.fn(() => ok(true)) },
    deviation: { retry: vi.fn(() => ok(state(current.task))), cancel: vi.fn(() => ok(true)) },
    diff: {
      stat: vi.fn(() => ok<workspaceTypes.DiffStat>({ changes: [], scope: { inScope: [], outOfScope: [], untouched: current.task.fileScope } })),
      file: vi.fn(() => ok('')),
    },
    verify: { run: vi.fn() },
    coding: {
      status: vi.fn(() =>
        ok<codingTypes.CodingRuntimeStatus>({
          backend: 'codex',
          protocol: 'codex-exec',
          boundary: 'separate-user',
          available: true,
          version: 'test',
          reason: null,
          config: { user: 'coding-agent', cli: 'codex', model: 'test-model', thinking: 'default', timeoutMinutes: 30 },
        }),
      ),
      start: vi.fn((_id: string, _input: codingTypes.CodingStart) => ok(current.task)),
      get: vi.fn(() => ok(current.task)),
      events: vi.fn((_id: string, _after: number) => ok<codingTypes.CodingEventPage>({ events: [], next: -1, truncated: false })),
      cancel: vi.fn(() => ok(true)),
      patch: vi.fn(() => ok<codingTypes.CodingPatchPreview>({ digest: 'test-digest', files: [], patch: '', blocked: [] })),
      apply: vi.fn((_id: string, _input: codingTypes.CodingApply) => ok<codingTypes.CodingApplyResult>({ files: [], markers: [], kept: [] })),
      active: vi.fn(() => ok<codingTypes.CodingActiveRun[]>([])),
      resume: vi.fn((_id: string) => ok(current.task)),
    },
    workspace: {
      info: vi.fn(() => ok<workspaceTypes.WorkspaceInfo>({ configured: false })),
      openFile: vi.fn(() => ok<workspaceTypes.OpenedWith>('vscode')),
      get: vi.fn(() =>
        ok<workspaceTypes.WorkspaceView>({
          root: '/repo',
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
        }),
      ),
    },
    ...fakeApi({
      commit: {
        preview: () => ok({ files: ['src/auth.ts'], skipped: [{ path: 'notes.md', reason: 'out_of_scope' }], message: '邮箱登录\n\nTaskPilot 工作包 t1' }),
        create: (_id, _message, files) => ok({ commit: 'c0ffee1234', files }),
      },
    }),
    notes: {
      list: vi.fn(() => ok<noteTypes.NoteList>({ revision: 1, directory: '/notes', custom: false, unavailable: null, truncated: false, notes: [] })),
      create: vi.fn((input: noteTypes.NoteInput) =>
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
      ),
      update: vi.fn(),
      remove: vi.fn(() => ok(true)),
    },
    practice: {
      reference: vi.fn(() => ok('diff --git a/src/auth.ts b/src/auth.ts\n+export const login = () => true;\n')),
      grade: vi.fn((_id: string, _skipReference: boolean) => ok(current.task)),
    },
    courses: { default: vi.fn(() => ok(PROGRAMMING_COURSE)) },
    tutor: {
      get: vi.fn(() => ok<tutorTypes.TutorState>({ status: 'idle', levels: [], pending: null, opened: 0, maxLevel: 5, error: null })),
      ask: vi.fn((_id: string, _stepIndex: number, level: number) =>
        ok<tutorTypes.TutorState>({ status: 'running', levels: [], pending: level, opened: level - 1, maxLevel: 5, error: null }),
      ),
      copied: vi.fn(() => ok(1)),
      cancel: vi.fn(() => ok(true)),
    },
  };
  Object.defineProperty(window, 'taskpilot', { value: api, configurable: true, writable: true });
  return api;
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
