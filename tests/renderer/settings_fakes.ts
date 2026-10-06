// Fake window.taskpilot for the settings and setup tests: every call resolves
// {ok: true, data} unless a test overrides it.
import { vi } from 'vitest';

type Result<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string; field?: string } };

export const ok = <T>(data: T): Promise<Result<T>> => Promise.resolve({ ok: true, data });

// Typed as any result, so it can replace a success in mockReturnValueOnce.
export const fail = (code: string, message: string, field?: string): Promise<Result<never>> => Promise.resolve({ ok: false, error: { code, message, field } });

export const preferences = () => ({
  profile: { displayName: 'Ada', avatarColor: 'ocean', initials: 'A' },
  appearance: { theme: 'system', vibrancy: false },
  environment: { pathSource: 'inherit' },
});

export const workspaceView = () => ({
  root: '/repo',
  commands: {},
  checks: {},
  lines: { test: 'npm test', lint: '', build: '', smoke: '' },
  options: {
    test: { stage: 'submit', blocking: true, reportPath: '' },
    lint: { stage: 'step', blocking: false, reportPath: '' },
    build: { stage: 'step', blocking: false, reportPath: '' },
    smoke: { stage: 'step', blocking: false, reportPath: '' },
  },
});

export const workspaceCheck = () => ({
  root: '/repo',
  normalizedFrom: null,
  repo: { commit: 'abcdef1234567890', branch: 'main', dirty: false, changedFiles: 0 },
  commands: {
    test: { configured: true, resolved: '/usr/local/bin/npm' },
    lint: { configured: false, resolved: null },
    build: { configured: false, resolved: null },
    smoke: { configured: false, resolved: null },
  },
});

export const envState = (overrides: Record<string, unknown> = {}) => ({
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
  steps: [
    { id: 'install', kind: 'install', script: null, line: 'npm ci --ignore-scripts', result: null },
    { id: 'test', kind: 'test', script: 'test', line: 'npm run test', result: null },
  ],
  configured: { test: '', lint: '', build: '', smoke: '' },
  ...overrides,
});

export const installApi = () => {
  const api = {
    listTasks: vi.fn(() => ok([])),
    workspace: {
      get: vi.fn(() => ok(workspaceView())),
      set: vi.fn((form: { root: string; commands: Record<string, string>; options: unknown }) =>
        ok({ ...workspaceView(), root: form.root, lines: { ...workspaceView().lines, ...form.commands } }),
      ),
      check: vi.fn(() => ok(workspaceCheck())),
      pickRoot: vi.fn(() => ok(null)),
      info: vi.fn(() => ok({ configured: false })),
    },
    preferences: {
      get: vi.fn(() => ok(preferences())),
      set: vi.fn((input: ReturnType<typeof preferences>) => ok({ ...input, profile: { ...input.profile, initials: 'X' } })),
    },
    environment: {
      info: vi.fn(() =>
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
      ),
    },
    data: {
      info: vi.fn(() => ok({ configDir: '/config', files: ['workspace.json'], packages: { total: 3, claimed: 1, deviations: 0 } })),
      resetProgress: vi.fn(() => ok({ total: 3, claimed: 0, deviations: 0 })),
      reveal: vi.fn(() => ok(true)),
    },
    env: {
      get: vi.fn(() => ok(envState())),
      plan: vi.fn(() => ok(envState())),
      setAllowScripts: vi.fn((allow: boolean) => ok(envState({ allowScripts: allow }))),
      runStep: vi.fn(() => ok(envState())),
      apply: vi.fn(() => ok(envState())),
      cancel: vi.fn(() => ok(true)),
    },
  };
  Object.defineProperty(window, 'taskpilot', { value: api, configurable: true, writable: true });
  return api;
};
