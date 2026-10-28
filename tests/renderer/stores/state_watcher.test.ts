// @vitest-environment happy-dom
import { beforeEach, expect, test, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises } from '@vue/test-utils';

import { createStateWatcher } from '../../../src/renderer/src/stores/state_watcher.ts';
import { useRepositoryIdentityStore } from '../../../src/renderer/src/stores/repository_identity.ts';
import { fakeApi } from '../ipc_fakes.ts';

let api: ReturnType<typeof fakeApi>;

beforeEach(() => {
  setActivePinia(createPinia());
  api = fakeApi();
  Object.assign(window, { taskpilot: api });
  useRepositoryIdentityStore().currentId = 'repo-a';
});

test('only events for the current repository and a watched domain read again', async () => {
  const read = vi.fn(async () => undefined);
  const watcher = createStateWatcher({ name: 'test', domains: ['release'], read });
  await watcher.start();
  expect(read).toHaveBeenCalledTimes(1);

  api.emitState({ repositoryId: 'repo-b', domains: ['release'] });
  api.emitState({ repositoryId: 'repo-a', domains: ['notes'] });
  await flushPromises();
  expect(read).toHaveBeenCalledTimes(1);

  api.emitState({ repositoryId: 'repo-a', domains: ['notes', 'release'] });
  await flushPromises();
  expect(read).toHaveBeenCalledTimes(2);
  watcher.stop();
});

test('a global watcher follows events from every repository', async () => {
  const read = vi.fn(async () => undefined);
  const watcher = createStateWatcher({ name: 'test', domains: ['notes'], global: true, initialRead: false, read });
  await watcher.start();
  expect(read).not.toHaveBeenCalled();
  api.emitState({ repositoryId: 'repo-b', domains: ['notes'] });
  await flushPromises();
  expect(read).toHaveBeenCalledTimes(1);
  watcher.stop();
});

test('events during a read queue exactly one more read, never a concurrent one', async () => {
  const held = Promise.withResolvers<void>();
  let running = 0;
  let peak = 0;
  const read = vi.fn(async () => {
    running += 1;
    peak = Math.max(peak, running);
    if (read.mock.calls.length === 1) await held.promise;
    running -= 1;
  });
  const watcher = createStateWatcher({ name: 'test', domains: ['release'], read });
  const first = watcher.start();
  for (let index = 0; index < 3; index += 1) api.emitState({ repositoryId: 'repo-a', domains: ['release'] });
  held.resolve();
  await first;
  await flushPromises();
  expect(read).toHaveBeenCalledTimes(2);
  expect(peak).toBe(1);
  watcher.stop();
});

test('a read still running when the watcher stops is reported stale', async () => {
  const held = Promise.withResolvers<void>();
  const seen: boolean[] = [];
  const watcher = createStateWatcher({
    name: 'test',
    domains: ['release'],
    read: async (isCurrent) => {
      await held.promise;
      seen.push(isCurrent());
    },
  });
  const first = watcher.start();
  watcher.stop();
  held.resolve();
  await first;
  expect(seen).toEqual([false]);
});

test('stop removes the listener and drops a queued read', async () => {
  const held = Promise.withResolvers<void>();
  const read = vi.fn(() => held.promise);
  const watcher = createStateWatcher({ name: 'test', domains: ['release'], read });
  const first = watcher.start();
  api.emitState({ repositoryId: 'repo-a', domains: ['release'] });
  watcher.stop();
  held.resolve();
  await first;
  api.emitState({ repositoryId: 'repo-a', domains: ['release'] });
  await flushPromises();
  expect(read).toHaveBeenCalledTimes(1);
  expect(watcher.active()).toBe(false);
});

test('a failed read is logged and the next event still reads', async () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const read = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(undefined);
  const watcher = createStateWatcher({ name: 'test', domains: ['release'], read });
  await watcher.start();
  expect(errors).toHaveBeenCalledWith('[test] refresh failed', expect.any(Error));
  api.emitState({ repositoryId: 'repo-a', domains: ['release'] });
  await flushPromises();
  expect(read).toHaveBeenCalledTimes(2);
  watcher.stop();
  errors.mockRestore();
});
