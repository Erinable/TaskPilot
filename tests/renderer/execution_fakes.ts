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
  baselineChecks: { status: 'measured', reason: null, commit: 'abcdef12', checks: {}, startedAt: '', finishedAt: null },
  adjudication: null,
  revision: null,
  humanTransitions: [],
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
});

const ok = <T>(data: T) => Promise.resolve({ ok: true as const, data });

// Installs window.taskpilot; `task` is what getTask() returns now.
export const installApi = (current: { task: ipc.TaskView }) => {
  const api = {
    listTasks: vi.fn(() => ok([current.task])),
    getTask: vi.fn(() => ok(current.task)),
    transition: vi.fn((_id: string, _name: ipc.HumanTransition, _options?: ipc.TransitionOptions) => ok(state(current.task))),
    measureBaseline: vi.fn(() => ok(current.task)),
    setStepDone: vi.fn((_id: string, stepIndex: number) => ok(state({ ...current.task, completedSteps: [stepIndex] }))),
    review: { retry: vi.fn(() => ok(state(current.task))), cancel: vi.fn(() => ok(true)) },
    deviation: { retry: vi.fn(() => ok(state(current.task))), cancel: vi.fn(() => ok(true)) },
    diff: {
      stat: vi.fn(() => ok<ipc.DiffStat>({ changes: [], scope: { inScope: [], outOfScope: [], untouched: current.task.fileScope } })),
      file: vi.fn(() => ok('')),
    },
    verify: { run: vi.fn() },
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
