// Shared fakes for the execution view tests: a TaskView builder and a
// window.taskpilot stub whose calls resolve {ok: true, data}.
import { vi } from 'vitest';

import type * as ipc from '../../src/shared/ipc_types.ts';

export const taskView = (overrides: Partial<ipc.TaskView> = {}): ipc.TaskView => ({
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
  baselineChecks: { status: 'measured', reason: null, commit: 'abcdef12', checks: {}, startedAt: '', finishedAt: null },
  adjudication: null,
  revision: null,
  humanTransitions: [],
  dependencies: [],
  completedAt: null,
  ...overrides,
});

export const state = (task: ipc.TaskView): ipc.WorkPackageState => ({
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
});

const ok = <T>(data: T) => Promise.resolve({ ok: true as const, data });

// Installs window.taskpilot; `task` is what getTask() returns now.
export const installApi = (current: { task: ipc.TaskView }) => {
  const api = {
    listTasks: vi.fn(() => ok([current.task])),
    getTask: vi.fn(() => ok(current.task)),
    transition: vi.fn((_id: string, _name: ipc.HumanTransition, _options?: ipc.TransitionOptions) => ok(state(current.task))),
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
      stat: vi.fn(() => ok<ipc.DiffStat>({ changes: [], scope: { inScope: [], outOfScope: [], untouched: current.task.fileScope } })),
      file: vi.fn(() => ok('')),
    },
    verify: { run: vi.fn() },
    coding: {
      status: vi.fn(() =>
        ok<ipc.CodingRuntimeStatus>({
          backend: 'codex',
          protocol: 'codex-exec',
          boundary: 'separate-user',
          available: true,
          version: 'test',
          reason: null,
          config: { user: 'coding-agent', cli: 'codex', model: 'test-model', thinking: 'default', timeoutMinutes: 30 },
        }),
      ),
      start: vi.fn((_id: string, _input: ipc.CodingStart) => ok(current.task)),
      get: vi.fn(() => ok(current.task)),
      events: vi.fn((_id: string, _after: number) => ok<ipc.CodingEventPage>({ events: [], next: -1, truncated: false })),
      cancel: vi.fn(() => ok(true)),
      patch: vi.fn(() => ok<ipc.CodingPatchPreview>({ digest: 'test-digest', files: [], patch: '', blocked: [] })),
      apply: vi.fn((_id: string, _input: ipc.CodingApply) => ok<ipc.CodingApplyResult>({ files: [] })),
      active: vi.fn(() => ok<ipc.CodingActiveRun[]>([])),
    },
    workspace: { info: vi.fn(() => ok<ipc.WorkspaceInfo>({ configured: false })), openFile: vi.fn(() => ok<ipc.OpenedWith>('vscode')) },
    commit: {
      preview: vi.fn(() =>
        ok<ipc.CommitPreview>({ files: ['src/auth.ts'], skipped: [{ path: 'notes.md', reason: 'out_of_scope' }], message: '邮箱登录\n\nTaskPilot 工作包 t1' }),
      ),
      create: vi.fn((_id: string, _message: string, files: string[]) => ok<ipc.CommitResult>({ commit: 'c0ffee1234', files })),
    },
    tutor: {
      get: vi.fn(() => ok<ipc.TutorState>({ status: 'idle', answer: null, error: null, costUsd: 0 })),
      ask: vi.fn(() => ok<ipc.TutorState>({ status: 'running', answer: null, error: null, costUsd: 0 })),
      cancel: vi.fn(() => ok(true)),
    },
  };
  Object.defineProperty(window, 'taskpilot', { value: api, configurable: true, writable: true });
  return api;
};

// A Coding Agent round, ready for review unless overridden.
export const codingRun = (overrides: Partial<ipc.CodingRun> = {}): ipc.CodingRun => {
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
