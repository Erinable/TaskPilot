// @vitest-environment happy-dom
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

import { useRepositoriesStore } from '../../../src/renderer/src/stores/repositories.ts';
import { useAppStore } from '../../../src/renderer/src/stores/app.ts';
import { readStorageKey, useNotificationsStore } from '../../../src/renderer/src/stores/notifications.ts';
import * as feedback from '../../../src/renderer/src/lib/feedback.ts';
import type * as ipc from '../../../src/shared/ipc_types.ts';

vi.mock('../../../src/renderer/src/lib/feedback.ts', () => {
  const showToast = vi.fn();
  // announceAgent adds a system notification only in the background; tests see the toast.
  return { showToast, announceAgent: (...args: unknown[]) => showToast(...args), confirmAction: vi.fn(async () => true), openDialogs: { value: 0 } };
});

const ok = <T>(data: T) => Promise.resolve({ ok: true as const, data });

const repo = (id: string, overrides: Partial<ipc.Repository> = {}): ipc.Repository => ({
  id,
  root: `/work/${id}`,
  name: id,
  lastOpenedAt: '',
  current: false,
  missing: false,
  counts: null,
  ...overrides,
});

const listOf = (current: string): ipc.RepositoryList => ({ current, repositories: ['a', 'b'].map((id) => repo(id, { current: id === current })) });

let busy: ipc.BusyRun[];
let api: ReturnType<typeof installApi>;

const installApi = () => {
  const stub = {
    repositories: {
      list: vi.fn(() => ok(listOf('a'))),
      busy: vi.fn(() => ok(busy)),
      switch: vi.fn((id: string) => ok(listOf(id))),
      add: vi.fn((root: string) => ok({ current: 'c', repositories: [repo('c', { root, current: true })] })),
      relocate: vi.fn((id: string, root: string) => ok({ current: 'a', repositories: [repo(id, { root, current: true })] })),
    },
    workspace: {
      pickRoot: vi.fn(() => ok<string | null>('/work/c')),
      info: vi.fn(() => ok({ configured: false } as ipc.WorkspaceInfo)),
    },
    requirements: { list: vi.fn(() => ok([])) },
    release: { updateDraft: vi.fn() },
    activity: { overview: vi.fn(() => ok(null)) },
    listTasks: vi.fn(() => ok([])),
  };
  Object.assign(window, { taskpilot: stub });
  return stub;
};

beforeEach(() => {
  setActivePinia(createPinia());
  localStorage.clear();
  busy = [];
  api = installApi();
  vi.mocked(feedback.confirmAction).mockClear();
  vi.mocked(feedback.confirmAction).mockResolvedValue(true);
});

describe('repositories store', () => {
  test('switching reloads the queue and remounts the views', async () => {
    const store = useRepositoriesStore();
    await store.refresh();
    expect(store.current?.id).toBe('a');
    const before = store.generation;

    expect(await store.switchTo('b')).toBe(true);
    expect(api.repositories.switch).toHaveBeenCalledWith('b');
    expect(api.listTasks).toHaveBeenCalled();
    expect(api.requirements.list).toHaveBeenCalled();
    expect(store.current?.id).toBe('b');
    expect(store.generation).toBe(before + 1);
    expect(feedback.confirmAction).not.toHaveBeenCalled();
  });

  test('running work is listed and a declined switch changes nothing', async () => {
    busy = [{ kind: 'review', label: '邮箱登录' }];
    vi.mocked(feedback.confirmAction).mockResolvedValueOnce(false);
    const store = useRepositoriesStore();
    await store.refresh();

    expect(await store.switchTo('b')).toBe(false);
    expect(vi.mocked(feedback.confirmAction).mock.calls[0][0].body).toContain('QA 审查：邮箱登录');
    expect(api.repositories.switch).not.toHaveBeenCalled();
    expect(store.current?.id).toBe('a');
  });

  test('unsaved settings that the user keeps stop the switch', async () => {
    const app = useAppStore();
    app.view = 'settings';
    app.setLeaveGuard(async () => false);
    const store = useRepositoriesStore();
    await store.refresh();
    expect(await store.switchTo('b')).toBe(false);
    expect(api.repositories.switch).not.toHaveBeenCalled();
  });

  test('leaving the execution view goes back to the queue', async () => {
    const app = useAppStore();
    app.view = 'execution';
    const store = useRepositoriesStore();
    await store.refresh();
    await store.switchTo('b');
    expect(app.view).toBe('queue');
  });

  test('a refused switch is reported and keeps the current repository', async () => {
    api.repositories.switch.mockResolvedValueOnce({ ok: false, error: { code: 'unknown_repository', message: 'x' } } as never);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = useRepositoriesStore();
    await store.refresh();
    expect(await store.switchTo('b')).toBe(false);
    spy.mockRestore();
    expect(feedback.showToast).toHaveBeenCalledWith('切换仓库失败：找不到这个仓库，它可能已被移除。');
    expect(store.current?.id).toBe('a');
  });

  test('adding the first repository picks a folder and opens it; a dismissed picker does nothing', async () => {
    const store = useRepositoriesStore();
    expect(await store.add()).toBe(true);
    expect(api.repositories.add).toHaveBeenCalledWith('/work/c', true);
    expect(store.current?.root).toBe('/work/c');

    api.workspace.pickRoot.mockResolvedValueOnce({ ok: true, data: null });
    expect(await store.add()).toBe(false);
    expect(api.repositories.add).toHaveBeenCalledTimes(1);
  });

  test('adding another repository lists it and keeps the open one, cancelling nothing', async () => {
    busy = [{ kind: 'review', label: '邮箱登录' }];
    api.repositories.add.mockImplementationOnce((root: string) => ok({ current: 'a', repositories: [...listOf('a').repositories, repo('c', { root })] }));
    const store = useRepositoriesStore();
    await store.refresh();
    const before = store.generation;
    expect(await store.add()).toBe(true);
    expect(api.repositories.add).toHaveBeenCalledWith('/work/c', false);
    expect(store.current?.id).toBe('a');
    expect(store.repositories.map((entry) => entry.id)).toEqual(['a', 'b', 'c']);
    expect(store.generation).toBe(before);
    expect(api.repositories.busy).not.toHaveBeenCalled();
    expect(feedback.confirmAction).not.toHaveBeenCalled();
    expect(feedback.showToast).toHaveBeenCalledWith('已添加 c，在侧栏「项目」里点它就能切换。');
  });

  test('relocating needs no confirmation and keeps the repository open', async () => {
    busy = [{ kind: 'review', label: 'x' }];
    const store = useRepositoriesStore();
    await store.refresh();
    expect(await store.relocate('a')).toBe(true);
    expect(api.repositories.relocate).toHaveBeenCalledWith('a', '/work/c');
    expect(feedback.confirmAction).not.toHaveBeenCalled();
    expect(store.current?.root).toBe('/work/c');
  });

  test('notification read state follows the open repository', async () => {
    localStorage.setItem(readStorageKey('b'), JSON.stringify(['t1:blocked']));
    const notifications = useNotificationsStore();
    notifications.useRepository('a');
    expect(notifications.isRead('t1:blocked')).toBe(false);

    const store = useRepositoriesStore();
    await store.refresh();
    await store.switchTo('b');
    expect(notifications.isRead('t1:blocked')).toBe(true);
  });
});
