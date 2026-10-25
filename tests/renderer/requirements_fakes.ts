// Shared fakes for the requirement center tests: a requirement builder and a
// window.taskpilot stub whose calls resolve {ok: true, data}.
import { vi } from 'vitest';

import type * as packageTypes from '../../src/shared/ipc/packages.ts';
import type * as releaseTypes from '../../src/shared/ipc/release.ts';
import type * as requirementTypes from '../../src/shared/ipc/requirements.ts';
import type * as settingsTypes from '../../src/shared/ipc/settings.ts';
import type * as workspaceTypes from '../../src/shared/ipc/workspace.ts';

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

const ok = <T>(data: T) => Promise.resolve({ ok: true as const, data });

// Installs window.taskpilot; `list` is what requirements.list() returns now.
export const installApi = (state: { list: requirementTypes.Requirement[] }) => {
  const api = {
    requirements: {
      list: vi.fn(() => ok(state.list)),
      create: vi.fn((input: requirementTypes.RequirementInput) =>
        ok(requirement({ id: 'new', status: 'clarifying', title: input.title ?? '', text: input.text })),
      ),
      clarify: vi.fn((id: string) => ok(requirement({ id, status: 'clarifying' }))),
      answer: vi.fn((id: string) => ok(requirement({ id, status: 'answering' }))),
      plan: vi.fn((id: string) => ok(requirement({ id, status: 'planning' }))),
      publish: vi.fn((id: string) =>
        ok(requirement({ id, status: 'published', plan: { summary: 's', packages: [planPackage()] }, packages: [{} as packageTypes.TaskDefinition] })),
      ),
      remove: vi.fn(() => ok(true as const)),
      cancel: vi.fn(() => ok(true)),
    },
    // MilestonePicker loads the release state when a requirement detail mounts.
    release: {
      get: vi.fn(() => ok<releaseTypes.ReleaseState>({ configured: false, draft: null, milestones: [], history: [], startPoint: null, running: false })),
    },
    agent: { status: vi.fn(() => ok<settingsTypes.AgentStatus>(agentStatus())) },
    workspace: {
      info: vi.fn(() => ok({ configured: false } as workspaceTypes.WorkspaceInfo)),
      get: vi.fn(() => ok({ root: null, steps: [], project: { status: 'missing' }, detected: [], presets: [] } as workspaceTypes.WorkspaceView)),
    },
    listTasks: vi.fn(() => ok([])),
  };
  (globalThis as unknown as { window: unknown }).window ??= globalThis;
  Object.assign(window, { taskpilot: api });
  return api;
};

// agent:status for a ready machine: analysis CLI signed in, coding CLI installed and signed in.
export const agentStatus = (overrides: Partial<settingsTypes.AgentStatus> = {}): settingsTypes.AgentStatus => ({
  available: true,
  command: 'claude',
  signIn: { state: 'signed_in', source: 'claude auth status' },
  coding: { cli: 'codex', installed: true, signIn: { state: 'signed_in', source: 'codex login status' } },
  ...overrides,
});
