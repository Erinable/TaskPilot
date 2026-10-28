// @vitest-environment happy-dom
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

import { useRepositoriesStore } from '../../../src/renderer/src/stores/repositories.ts';
import { useAppStore } from '../../../src/renderer/src/stores/app.ts';
import { useActivityFeedStore } from '../../../src/renderer/src/stores/activity_feed.ts';
import { useCommitStore } from '../../../src/renderer/src/stores/commit.ts';
import { useEngineeringMapStore } from '../../../src/renderer/src/stores/engineering_map.ts';
import { useOnboardingStore } from '../../../src/renderer/src/stores/onboarding.ts';
import { useTutorStore } from '../../../src/renderer/src/stores/tutor.ts';
import { readStorageKey, useNotificationsStore } from '../../../src/renderer/src/stores/notifications.ts';
import * as feedback from '../../../src/renderer/src/lib/feedback.ts';
import type * as activityTypes from '../../../src/shared/ipc/activity.ts';
import type { IpcResult } from '../../../src/shared/ipc/envelope.ts';
import type * as commitTypes from '../../../src/shared/ipc/commit.ts';
import type * as repositoryTypes from '../../../src/shared/ipc/repositories.ts';
import type * as settingsTypes from '../../../src/shared/ipc/settings.ts';
import type * as tutorTypes from '../../../src/shared/ipc/tutor.ts';
import type * as workspaceTypes from '../../../src/shared/ipc/workspace.ts';
import { defaultCourse } from '../settings_fakes.ts';
import { installFakeApi, ok } from '../ipc_fakes.ts';
import { activityOverview } from '../activity_fakes.ts';

vi.mock('../../../src/renderer/src/lib/feedback.ts', () => {
  const showToast = vi.fn();
  // announceAgent adds a system notification only in the background; tests see the toast.
  return { showToast, announceAgent: (...args: unknown[]) => showToast(...args), confirmAction: vi.fn(async () => true), openDialogs: { value: 0 } };
});

const repo = (id: string, overrides: Partial<repositoryTypes.Repository> = {}): repositoryTypes.Repository => ({
  id,
  root: `/work/${id}`,
  name: id,
  lastOpenedAt: '',
  current: false,
  missing: false,
  counts: null,
  ...overrides,
});

const listOf = (current: string): repositoryTypes.RepositoryList => ({ current, repositories: ['a', 'b'].map((id) => repo(id, { current: id === current })) });

let busy: repositoryTypes.BusyRun[];
let api: ReturnType<typeof installApi>;

const installApi = () =>
  installFakeApi({
    repositories: {
      list: () => ok(listOf('a')),
      busy: () => ok(busy),
      switch: (id: string) => ok(listOf(id)),
      add: (root: string) => ok({ current: 'c', repositories: [repo('c', { root, current: true })] }),
      relocate: (id: string, root: string) => ok({ current: 'a', repositories: [repo(id, { root, current: true })] }),
    },
    workspace: {
      pickRoot: () => ok<string | null>('/work/c'),
      info: () => ok({ configured: false } as workspaceTypes.WorkspaceInfo),
    },
    requirements: { list: () => ok([]) },
    activity: { overview: () => ok(activityOverview()) },
    tasks: { list: () => ok([]) },
  });

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
    expect(store.current?.id).toBe('b');
    expect(store.generation).toBe(before + 1);
  });

  test('switching clears what the views read for the old repository', async () => {
    const tutorState: tutorTypes.TutorState = { status: 'done', levels: [], pending: null, opened: 1, maxLevel: 5, error: null };
    const preview: commitTypes.CommitPreview = { files: ['a.ts'], skipped: [], message: 'feat: a' };
    const map: activityTypes.EngineeringMap = { modules: [], conventions: [], gaps: [], files: ['a.ts'], truncated: false };
    api.activity.page.mockImplementation(() =>
      ok({ days: [{ day: '2026-10-25', records: [] }], nextBefore: '2026-10-24', timeZone: 'Asia/Shanghai', retentionDays: 30 }),
    );
    api.commit.preview.mockImplementation(() => ok(preview));
    api.engineeringMap.get.mockImplementation(() => ok(map));
    api.agent.status.mockImplementation(() => ok({ available: true } as settingsTypes.AgentStatus));
    api.workspace.get.mockImplementation(() =>
      ok<workspaceTypes.WorkspaceView>({
        root: '/r',
        steps: [
          {
            id: 'test',
            label: null,
            effective: { lines: ['npm test'], cwd: '', stage: 'submit', blocking: true, parser: { format: 'tests' }, timeoutSeconds: null },
            source: 'local',
            skipped: null,
            local: null,
            suggestions: [],
          },
        ],
        project: { status: 'missing' },
        course: defaultCourse(),
        detected: [],
        presets: [],
      }),
    );
    api.tutor.get.mockImplementation(() => ok(tutorState));
    const feed = useActivityFeedStore();
    const commit = useCommitStore();
    const engineeringMap = useEngineeringMapStore();
    const onboarding = useOnboardingStore();
    const tutor = useTutorStore();
    await Promise.all([feed.open(), commit.open('p1'), engineeringMap.open(), onboarding.recheck(), tutor.refresh('p1', 0)]);
    expect(feed.days).toHaveLength(1);
    expect(commit.preview).toEqual(preview);
    expect(engineeringMap.map).toEqual(map);
    expect(onboarding.testCommand).toBe('npm test');
    expect(tutor.stateOf('p1', 0)).toEqual(tutorState);

    const store = useRepositoriesStore();
    await store.refresh();
    expect(await store.switchTo('b')).toBe(true);
    expect(feed.days).toEqual([]);
    expect(feed.nextBefore).toBeNull();
    expect(commit.preview).toBeNull();
    expect(commit.message).toBe('');
    expect(engineeringMap.map).toBeNull();
    expect(onboarding.agent).toBeNull();
    expect(onboarding.testCommand).toBeNull();
    expect(tutor.stateOf('p1', 0)).toBeNull();
  });

  test('an answer for the old repository that lands after the switch is dropped', async () => {
    const held = Promise.withResolvers<IpcResult<activityTypes.EngineeringMap>>();
    api.engineeringMap.get.mockReturnValueOnce(held.promise);
    const engineeringMap = useEngineeringMapStore();
    const loading = engineeringMap.open();
    expect(engineeringMap.loading).toBe(true);

    const store = useRepositoriesStore();
    await store.refresh();
    expect(await store.switchTo('b')).toBe(true);
    held.resolve({ ok: true, data: { modules: [], conventions: [], gaps: [], files: ['old.ts'], truncated: false } });
    await loading;
    expect(engineeringMap.map).toBeNull();
    expect(engineeringMap.loading).toBe(false);
  });

  test.each([
    { kind: 'review' as const, label: '邮箱登录', text: 'QA 审查：邮箱登录' },
    { kind: 'release' as const, label: null, text: 'Release Manager：发布说明' },
  ])('a declined switch describes %s work', async (entry) => {
    busy = [entry];
    vi.mocked(feedback.confirmAction).mockResolvedValueOnce(false);
    const store = useRepositoriesStore();
    await store.refresh();

    expect(await store.switchTo('b')).toBe(false);
    expect(vi.mocked(feedback.confirmAction).mock.calls[0][0].body).toContain(entry.text);
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
