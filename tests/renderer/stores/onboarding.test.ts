// @vitest-environment happy-dom
import { beforeEach, expect, test } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises } from '@vue/test-utils';

import { useOnboardingStore } from '@/stores/onboarding.ts';
import { useRepositoryIdentityStore } from '@/stores/repository_identity.ts';
import type { AgentStatus } from '@shared/ipc/settings.ts';
import type { IpcResult } from '@shared/ipc/envelope.ts';
import { agentStatus, installApi } from '../requirements_fakes.ts';
import { ok } from '../ipc_fakes.ts';

beforeEach(() => {
  localStorage.removeItem('taskpilot.onboarding.path');
  setActivePinia(createPinia());
});

test('a response from before a repository reset cannot restore old readiness', async () => {
  const api = installApi({ list: [] });
  const held = Promise.withResolvers<IpcResult<AgentStatus>>();
  api.agent.status.mockReturnValueOnce(held.promise);
  const store = useOnboardingStore();
  const reading = store.start();
  store.choosePath('course');
  store.reset();
  held.resolve({ ok: true, data: agentStatus() });
  await reading;
  expect(store.agent).toBeNull();
  expect(store.checksReady).toBeNull();
  expect(store.checking).toBe(false);
  expect(store.path).toBe('course');
  store.stop();
});

test('only current workspace and preference events refresh readiness while active', async () => {
  const api = installApi({ list: [] });
  useRepositoryIdentityStore().currentId = 'repo-a';
  const store = useOnboardingStore();
  await store.start();
  expect(store.checksReady).toBe(false);
  const response = await api.workspace.get();
  if (!response.ok) throw new Error('Missing workspace fixture');
  api.workspace.get.mockReturnValue(
    ok({
      ...response.data,
      steps: [
        {
          id: 'custom:grade',
          label: '评分',
          source: 'project',
          skipped: null,
          local: null,
          suggestions: [],
          effective: { lines: ['make grade'], cwd: '', stage: 'submit', blocking: true, parser: { format: 'tests' }, timeoutSeconds: null },
        },
      ],
    }),
  );
  const calls = api.agent.status.mock.calls.length;
  api.emitState({ repositoryId: 'repo-b', domains: ['workspace'] });
  api.emitState({ repositoryId: 'repo-a', domains: ['notes'] });
  await flushPromises();
  expect(api.agent.status).toHaveBeenCalledTimes(calls);
  api.emitState({ repositoryId: 'repo-a', domains: ['workspace'] });
  await flushPromises();
  expect(store.checksReady).toBe(true);
  api.emitState({ repositoryId: 'repo-a', domains: ['preferences'] });
  await flushPromises();
  expect(api.agent.status).toHaveBeenCalledTimes(calls + 2);
  store.stop();
  api.emitState({ repositoryId: 'repo-a', domains: ['workspace'] });
  await flushPromises();
  expect(api.agent.status).toHaveBeenCalledTimes(calls + 2);
});
