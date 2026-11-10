// @vitest-environment happy-dom
import { beforeEach, expect, test, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises } from '@vue/test-utils';
import { reactive } from 'vue';

import { useSettingsStore } from '@/stores/settings.ts';
import { fail, installApi, ok, preferences } from '../settings_fakes.ts';
import type { EnvironmentInfo, EnvironmentInfoOptions, Preferences } from '@shared/ipc/settings.ts';
import type { IpcResult } from '@shared/ipc/envelope.ts';

vi.mock('@/lib/feedback.ts', () => ({ showToast: vi.fn(), confirmAction: vi.fn(), confirmChoice: vi.fn(), openDialogs: { value: 0 } }));

const environmentInfo = (overrides: Partial<EnvironmentInfo> = {}): EnvironmentInfo => ({
  requested: 'auto',
  source: 'auto',
  error: null,
  shell: '/bin/zsh',
  entries: ['/usr/bin', '/Users/ada/.local/bin'],
  inheritedCount: 1,
  platform: 'darwin',
  versions: { app: '0.1.0', electron: '40', node: '22' },
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  setActivePinia(createPinia());
});

const loaded = async (extraPaths: string[] = []) => {
  let saved: Preferences = { ...preferences(), environment: { pathSource: 'auto', extraPaths } };
  const api = installApi({
    preferences: {
      get: () => ok(saved),
      set: (input) => {
        saved = { ...input, profile: { ...input.profile, initials: 'A' } };
        return ok(saved);
      },
    },
    environment: {
      info: (options) => ok(environmentInfo({ requested: options?.source ?? 'auto', source: options?.source ?? 'auto' })),
      pickExecutable: () => ok(null),
    },
  });
  const settings = useSettingsStore();
  await settings.open('profile');
  return { api, settings };
};

test('picking runtime executables previews ordered unique directories without saving until requested', async () => {
  const { api, settings } = await loaded(['/other/bin', '/chosen/bin']);
  api.environment.pickExecutable.mockResolvedValueOnce({ ok: true, data: { path: '/chosen/bin/claude', directory: '/chosen/bin' } });
  await settings.selectRuntimeExecutable('claude');
  expect(api.environment.pickExecutable).toHaveBeenCalledWith('claude');
  expect(settings.preferencesDraft!.environment.extraPaths).toEqual(['/chosen/bin', '/other/bin']);
  expect(settings.savedPreferences!.environment.extraPaths).toEqual(['/other/bin', '/chosen/bin']);
  expect(settings.dirtyPages.environment).toBe(true);
  expect(settings.dirtyPages.agents).toBe(false);
  expect(api.preferences.set).not.toHaveBeenCalled();
  expect(api.environment.info).toHaveBeenCalledWith({ source: 'auto', extraPaths: ['/chosen/bin', '/other/bin'], refresh: true });

  api.environment.pickExecutable.mockResolvedValueOnce({ ok: true, data: { path: '/chosen/bin/node', directory: '/chosen/bin' } });
  await settings.selectRuntimeExecutable('node');
  expect(settings.preferencesDraft!.environment.extraPaths).toEqual(['/chosen/bin', '/other/bin']);
  api.environment.pickExecutable.mockResolvedValueOnce({ ok: true, data: { path: '/node/bin/node', directory: '/node/bin' } });
  await settings.selectRuntimeExecutable('node');
  expect(settings.preferencesDraft!.environment.extraPaths).toEqual(['/node/bin', '/chosen/bin', '/other/bin']);

  expect(await settings.saveAll()).toBe(true);
  const payload = api.preferences.set.mock.calls[0][0];
  expect(structuredClone(payload).environment).toEqual({ pathSource: 'auto', extraPaths: ['/node/bin', '/chosen/bin', '/other/bin'] });
  expect(settings.anyDirty).toBe(false);
});

test('cancelling the executable picker preserves the draft and does not preview or save', async () => {
  const { api, settings } = await loaded(['/existing/bin']);
  const before = settings.extraPathText;
  await settings.selectRuntimeExecutable('codex');
  expect(api.environment.pickExecutable).toHaveBeenCalledWith('codex');
  expect(settings.extraPathText).toBe(before);
  expect(settings.selectingRuntime).toBe(false);
  expect(settings.anyDirty).toBe(false);
  expect(api.environment.info).not.toHaveBeenCalled();
  expect(api.preferences.set).not.toHaveBeenCalled();
});

test('supplemental directories are copied independently on load, discard and IPC save', async () => {
  const source = ['/original/bin'];
  const { api, settings } = await loaded(source);
  source.push('/outside/change');
  settings.preferencesDraft!.environment.extraPaths!.push('/draft/change');
  expect(settings.savedPreferences!.environment.extraPaths).toEqual(['/original/bin']);
  settings.discardAll();
  expect(settings.preferencesDraft!.environment.extraPaths).toEqual(['/original/bin']);
  expect(settings.anyDirty).toBe(false);

  const directories = reactive(['/custom/bin']);
  settings.preferencesDraft!.environment.extraPaths = directories;
  expect(await settings.saveAll()).toBe(true);
  const payload = api.preferences.set.mock.calls[0][0];
  expect(structuredClone(payload).environment.extraPaths).toEqual(['/custom/bin']);
  directories.push('/after/save');
  settings.preferencesDraft!.environment.extraPaths!.push('/later/draft');
  expect(payload.environment.extraPaths).toEqual(['/custom/bin']);
  expect(settings.savedPreferences!.environment.extraPaths).toEqual(['/custom/bin']);
  settings.discardAll();
  expect(settings.preferencesDraft!.environment.extraPaths).toEqual(['/custom/bin']);
});

test('a newer PATH preview wins over an older source response and its inherited directories', async () => {
  const { api, settings } = await loaded(['/custom/bin']);
  const pending = Promise.withResolvers<IpcResult<EnvironmentInfo>>();
  let inheritedCalls = 0;
  api.environment.info.mockImplementation((options?: EnvironmentInfoOptions) => {
    if (options?.source === 'inherit') {
      inheritedCalls += 1;
      return ok(environmentInfo({ source: 'inherit', entries: [inheritedCalls === 1 ? '/old/inherited' : '/new/inherited'] }));
    }
    if (options?.source === 'auto') return pending.promise;
    return ok(environmentInfo({ requested: 'login-shell', source: 'login-shell', entries: ['/new/inherited', '/new/shell'] }));
  });
  const old = settings.renderEnvironment();
  expect(settings.environmentLoading).toBe(true);
  settings.preferencesDraft!.environment.pathSource = 'login-shell';
  settings.preferencesDraft!.environment.extraPaths!.push('/second/bin');
  await settings.renderEnvironment({ refresh: true });
  expect(settings.environment?.entries).toEqual(['/new/inherited', '/new/shell']);
  expect(settings.inheritedEntries).toEqual(new Set(['/new/inherited']));
  expect(settings.environmentLoading).toBe(false);
  pending.resolve({ ok: true, data: environmentInfo({ entries: ['/old/inherited', '/stale/bin'] }) });
  await old;
  expect(settings.environment?.source).toBe('login-shell');
  expect(settings.environment?.entries).toEqual(['/new/inherited', '/new/shell']);
  expect(settings.inheritedEntries).toEqual(new Set(['/new/inherited']));
  expect(api.environment.info.mock.calls[0][0]?.extraPaths).toEqual(['/custom/bin']);
  expect(structuredClone(api.environment.info.mock.calls[2][0])).toEqual({ source: 'login-shell', extraPaths: ['/custom/bin', '/second/bin'], refresh: true });
});

test('a stale PATH preview failure cannot replace the latest successful runtime results', async () => {
  const { api, settings } = await loaded();
  const pending = Promise.withResolvers<IpcResult<EnvironmentInfo>>();
  api.environment.info.mockImplementation((options) => (options?.source === 'inherit' ? ok(environmentInfo({ source: 'inherit' })) : pending.promise));
  const old = settings.renderEnvironment();
  settings.preferencesDraft!.environment.pathSource = 'inherit';
  await settings.renderEnvironment();
  pending.resolve(await fail('unknown', 'old preview failed'));
  await old;
  expect(settings.environmentError).toBeNull();
  expect(settings.environmentLoading).toBe(false);
  expect(settings.environment?.source).toBe('inherit');
});

test('a failed current runtime preview is recoverable without discarding supplemental directories', async () => {
  const { api, settings } = await loaded(['/keep/bin']);
  api.environment.info.mockImplementation(() => fail('unknown', 'runtime discovery unavailable'));
  await settings.renderEnvironment();
  expect(settings.environmentError).toContain('runtime discovery unavailable');
  expect(settings.preferencesDraft!.environment.extraPaths).toEqual(['/keep/bin']);
  expect(settings.environmentLoading).toBe(false);
  api.environment.info.mockImplementation(() => ok(environmentInfo()));
  await settings.renderEnvironment({ refresh: true });
  expect(settings.environmentError).toBeNull();
  expect(settings.environment?.entries).toEqual(['/usr/bin', '/Users/ada/.local/bin']);
});

test('the explicit CLI refresh invalidates main-process discovery and rejects a late old runtime reply', async () => {
  const { api, settings } = await loaded();
  const pending = Promise.withResolvers<Awaited<ReturnType<typeof api.agent.runtimes>>>();
  api.agent.runtimes.mockReturnValueOnce(pending.promise);
  const old = settings.refreshAgentRuntimes();
  api.agent.runtimes.mockResolvedValueOnce({ ok: true, data: [] });
  await settings.refreshAgentRuntimes();
  expect(api.agent.runtimes).toHaveBeenNthCalledWith(1, { refresh: true });
  expect(api.agent.runtimes).toHaveBeenNthCalledWith(2, { refresh: true });
  pending.resolve({
    ok: true,
    data: [{ agent: 'qa', config: preferences().agents.qa, command: '/old/bin/claude', available: false, version: null, reason: 'old result' }],
  });
  await old;
  await flushPromises();
  expect(settings.agentRuntimes).toEqual([]);
  expect(settings.agentRuntimeLoading).toBe(false);
});
