// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

import { READ_STORAGE_KEY, useNotificationsStore } from '../../../src/renderer/src/stores/notifications.ts';
import { useTasksStore } from '../../../src/renderer/src/stores/tasks.ts';
import { useRequirementsStore } from '../../../src/renderer/src/stores/requirements.ts';
import { useExecutionStore } from '../../../src/renderer/src/stores/execution.ts';
import { MAX_NOTIFICATIONS } from '../../../src/renderer/src/lib/notifications.ts';
import { taskView } from '../execution_fakes.ts';
import { installApi, requirement } from '../requirements_fakes.ts';
import type * as requirementTypes from '../../../src/shared/ipc/requirements.ts';

vi.mock('../../../src/renderer/src/lib/feedback.ts', () => {
  const showToast = vi.fn();
  // announceAgent adds a system notification only in the background; tests see the toast.
  return { showToast, announceAgent: (...args: unknown[]) => showToast(...args), confirmAction: vi.fn(async () => true), openDialogs: { value: 0 } };
});

const stored = () => JSON.parse(localStorage.getItem(READ_STORAGE_KEY) ?? 'null');

describe('notifications store', () => {
  let state: { list: requirementTypes.Requirement[] };
  let api: ReturnType<typeof installApi>;

  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
    state = { list: [] };
    api = installApi(state);
  });

  afterEach(() => {
    vi.useRealTimers();
    useNotificationsStore().stop();
  });

  test('unread count, mark read and mark all read persist on this machine', () => {
    useTasksStore().tasks = [taskView({ status: 'blocked' })];
    useRequirementsStore().items = [requirement({ updatedAt: 'u1' })];
    const store = useNotificationsStore();
    expect(store.unreadCount).toBe(2);

    store.markRead('t1:blocked');
    expect(store.unreadCount).toBe(1);
    expect(stored()).toEqual(['t1:blocked']);

    store.markAllRead();
    expect(store.unreadCount).toBe(0);
    expect(stored().sort()).toEqual(['r1:answering:u1', 't1:blocked']);

    // A new pinia (an app restart) reads the same state back.
    setActivePinia(createPinia());
    useTasksStore().tasks = [taskView({ status: 'blocked' })];
    useRequirementsStore().items = [requirement({ updatedAt: 'u2' })];
    const restarted = useNotificationsStore();
    expect(restarted.isRead('t1:blocked')).toBe(true);
    // The requirement changed since, so it is unread again.
    expect(restarted.unreadCount).toBe(1);
  });

  test('a corrupt stored value reads as nothing read', () => {
    localStorage.setItem(READ_STORAGE_KEY, '{not json');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    useTasksStore().tasks = [taskView({ status: 'blocked' })];
    expect(useNotificationsStore().unreadCount).toBe(1);
    localStorage.setItem(READ_STORAGE_KEY, JSON.stringify({ a: 1 }));
    setActivePinia(createPinia());
    useTasksStore().tasks = [taskView({ status: 'blocked' })];
    expect(useNotificationsStore().unreadCount).toBe(1);
  });

  test('refresh reloads both stores and prunes read ids that no longer exist', async () => {
    localStorage.setItem(READ_STORAGE_KEY, JSON.stringify(['t1:blocked', 'gone:review:x', 'r1:answering:old']));
    api.tasks.list.mockImplementation(() => Promise.resolve({ ok: true as const, data: [taskView({ status: 'blocked' })] as never[] }));
    state.list = [requirement({ updatedAt: 'new' })];
    const store = useNotificationsStore();
    await store.refresh();
    expect(stored()).toEqual(['t1:blocked']);
    expect(store.unreadCount).toBe(1);
  });

  test('a failed queue reload logs and keeps the read state', async () => {
    localStorage.setItem(READ_STORAGE_KEY, JSON.stringify(['t1:blocked']));
    api.tasks.list.mockImplementation(() => Promise.resolve({ ok: false, error: { code: 'boom', message: 'x' } } as never));
    await useNotificationsStore().refresh();
    expect(stored()).toEqual(['t1:blocked']);
  });

  test('the list and the badge are capped', () => {
    useTasksStore().tasks = Array.from({ length: MAX_NOTIFICATIONS + 10 }, (_, index) => taskView({ id: `t${index}`, status: 'blocked' }));
    const store = useNotificationsStore();
    expect(store.items).toHaveLength(MAX_NOTIFICATIONS);
    expect(store.unreadCount).toBe(MAX_NOTIFICATIONS);
  });

  test('opening an item marks it read and navigates', async () => {
    useTasksStore().tasks = [taskView({ status: 'blocked' })];
    useRequirementsStore().items = [requirement({ updatedAt: 'u1' })];
    const store = useNotificationsStore();
    const openPackage = vi.spyOn(useExecutionStore(), 'open').mockResolvedValue();
    const openRequirement = vi.spyOn(useRequirementsStore(), 'open').mockResolvedValue();
    const [first, second] = store.items;
    await store.openItem(first);
    await store.openItem(second);
    expect(openPackage).toHaveBeenCalledWith('t1');
    expect(openRequirement).toHaveBeenCalledWith({ id: 'r1' });
    expect(store.unreadCount).toBe(0);
  });

  test('refreshes on relevant events and unsubscribes on stop', async () => {
    const store = useNotificationsStore();
    store.start();
    await vi.waitFor(() => expect(api.tasks.list).toHaveBeenCalled());
    api.tasks.list.mockClear();
    api.emitState({ repositoryId: null, domains: ['packages'] });
    await vi.waitFor(() => expect(api.tasks.list).toHaveBeenCalledTimes(1));
    store.stop();
    api.tasks.list.mockClear();
    api.emitState({ repositoryId: null, domains: ['packages'] });
    await Promise.resolve();
    expect(api.tasks.list).not.toHaveBeenCalled();
  });
});
