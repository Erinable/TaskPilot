// Shared fakes for the requirement center tests: a requirement builder and a
// window.taskpilot stub whose calls resolve {ok: true, data}.
import { vi } from 'vitest';

import type * as ipc from '../../src/shared/ipc_types.ts';

export const requirement = (overrides: Partial<ipc.Requirement> = {}): ipc.Requirement => ({
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

export const planPackage = (overrides: Partial<ipc.PlanPackage> = {}): ipc.PlanPackage => ({
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

const ok = <T>(data: T) => Promise.resolve({ ok: true as const, data });

// Installs window.taskpilot; `list` is what requirements.list() returns now.
export const installApi = (state: { list: ipc.Requirement[] }) => {
  const api = {
    requirements: {
      list: vi.fn(() => ok(state.list)),
      create: vi.fn((input: ipc.RequirementInput) => ok(requirement({ id: 'new', status: 'clarifying', title: input.title ?? '', text: input.text }))),
      clarify: vi.fn((id: string) => ok(requirement({ id, status: 'clarifying' }))),
      answer: vi.fn((id: string) => ok(requirement({ id, status: 'answering' }))),
      plan: vi.fn((id: string) => ok(requirement({ id, status: 'planning' }))),
      publish: vi.fn((id: string) =>
        ok(requirement({ id, status: 'published', plan: { summary: 's', packages: [planPackage()] }, packages: [{} as ipc.TaskDefinition] })),
      ),
      remove: vi.fn(() => ok(true as const)),
      cancel: vi.fn(() => ok(true)),
    },
    // MilestonePicker loads the release state when a requirement detail mounts.
    release: {
      get: vi.fn(() => ok<ipc.ReleaseState>({ configured: false, draft: null, milestones: [], history: [], startPoint: null, running: false })),
    },
    agent: { status: vi.fn(() => ok<ipc.AgentStatus>({ available: true, command: 'claude' })) },
    workspace: {
      info: vi.fn(() => ok({ configured: false } as ipc.WorkspaceInfo)),
      get: vi.fn(() => ok({ lines: { test: '' } } as ipc.WorkspaceView)),
    },
    listTasks: vi.fn(() => ok([])),
  };
  (globalThis as unknown as { window: unknown }).window ??= globalThis;
  Object.assign(window, { taskpilot: api });
  return api;
};
