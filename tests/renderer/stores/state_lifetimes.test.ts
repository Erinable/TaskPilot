// @vitest-environment happy-dom
import { beforeEach, expect, onTestFinished, test, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises } from '@vue/test-utils';
import { nextTick } from 'vue';

import { useAppStore } from '../../../src/renderer/src/stores/app.ts';
import { useReleaseStore } from '../../../src/renderer/src/stores/release.ts';
import { useSetupStore } from '../../../src/renderer/src/stores/setup.ts';
import { useNotesStore } from '../../../src/renderer/src/stores/notes.ts';
import { useSettingsStore } from '../../../src/renderer/src/stores/settings.ts';
import { useRequirementsStore } from '../../../src/renderer/src/stores/requirements.ts';
import { useCodingActivityStore } from '../../../src/renderer/src/stores/coding_activity.ts';
import { useRepositoryIdentityStore } from '../../../src/renderer/src/stores/repository_identity.ts';
import { installApi as executionApi, taskView } from '../execution_fakes.ts';
import { installApi as settingsApi, envState } from '../settings_fakes.ts';
import { installReleaseApi, releaseState, draft } from '../release_fakes.ts';
import { fakeApi, ok } from '../ipc_fakes.ts';
import { requirement } from '../requirements_fakes.ts';
import type { IpcResult } from '../../../src/shared/ipc/envelope.ts';
import type { Note, NoteList } from '../../../src/shared/ipc/notes.ts';
import type { WorkspaceInfo, WorkspaceView } from '../../../src/shared/ipc/workspace.ts';
import type { Requirement } from '../../../src/shared/ipc/requirements.ts';

vi.mock('../../../src/renderer/src/lib/feedback.ts', () => ({
  showToast: vi.fn(),
  announceAgent: vi.fn(),
  confirmAction: vi.fn(async () => true),
  confirmChoice: vi.fn(async () => 'accept'),
  openDialogs: { value: 0 },
}));

beforeEach(() => setActivePinia(createPinia()));

const noteList = (revision: number): NoteList => ({ revision, directory: `/notes/${revision}`, custom: false, unavailable: null, truncated: false, notes: [] });

test('release re-entry drains a new read after an old session response is discarded', async () => {
  const state = { current: releaseState({ draft: draft({ notesText: 'New session notes' }) }) };
  const api = installReleaseApi(state);
  const held = Promise.withResolvers<Awaited<ReturnType<typeof api.get>>>();
  api.get.mockReturnValueOnce(held.promise);
  const store = useReleaseStore();
  onTestFinished(() => store.leave());
  const oldEntry = store.enter();
  store.leave();
  await store.enter();
  held.resolve({ ok: true, data: releaseState({ draft: draft({ notesText: 'Old session notes' }) }) });
  await oldEntry;
  await flushPromises();
  expect(store.notesText).toBe('New session notes');
});

test('notes re-entry does not strand the first new-session refresh', async () => {
  const api = executionApi({ task: taskView() });
  const held = Promise.withResolvers<IpcResult<NoteList>>();
  api.notes.list.mockReturnValueOnce(held.promise);
  api.notes.list.mockResolvedValue({ ok: true, data: noteList(2) });
  const store = useNotesStore();
  onTestFinished(() => store.stopWatching());
  store.startWatching();
  store.stopWatching();
  store.startWatching();
  held.resolve({ ok: true, data: noteList(1) });
  await flushPromises();
  expect(store.directory).toBe('/notes/2');
});

test('setup re-entry and repository changes refresh the mounted settings page', async () => {
  const api = settingsApi();
  useAppStore().view = 'settings';
  const settings = useSettingsStore();
  settings.activePage = 'setup';
  const held = Promise.withResolvers<Awaited<ReturnType<typeof api.env.get>>>();
  api.env.get.mockReturnValueOnce(held.promise);
  api.env.get.mockReturnValue(ok(envState({ root: '/new' })));
  const store = useSetupStore();
  onTestFinished(() => {
    settings.activePage = 'profile';
  });
  settings.activePage = 'profile';
  await nextTick();
  settings.activePage = 'setup';
  await nextTick();
  held.resolve(await ok(envState({ root: '/old' })));
  await flushPromises();
  expect(store.view?.root).toBe('/new');
  api.env.get.mockReturnValue(ok(envState({ root: '/next-repository' })));
  useRepositoryIdentityStore().currentId = 'next';
  await flushPromises();
  expect(store.view?.root).toBe('/next-repository');
});

test('an old workspace response cannot overwrite the current repository status', async () => {
  const held = Promise.withResolvers<IpcResult<WorkspaceInfo>>();
  const current = { configured: false } as const;
  const api = fakeApi({ workspace: { info: () => ok(current) } });
  Object.assign(window, { taskpilot: api });
  api.workspace.info.mockReturnValueOnce(held.promise);
  const app = useAppStore();
  const old = app.refreshWorkspaceStatus();
  useRepositoryIdentityStore().currentId = 'new';
  await app.refreshWorkspaceStatus();
  held.resolve({ ok: false, error: { code: 'root_not_found', message: 'Old root missing' } });
  await old;
  expect(app.workspaceInfo).toEqual(current);
  expect(app.workspaceError).toBeNull();
});

test('an old settings load cannot restore the previous repository draft', async () => {
  const api = settingsApi();
  const initial = await api.workspace.get();
  if (!initial.ok) throw new Error(initial.error.message);
  const held = Promise.withResolvers<IpcResult<WorkspaceView>>();
  api.workspace.get.mockReturnValueOnce(held.promise);
  const settings = useSettingsStore();
  const old = settings.load();
  useRepositoryIdentityStore().currentId = 'new';
  api.workspace.get.mockReturnValue(ok({ ...initial.data, root: '/new' }));
  await settings.load();
  held.resolve(await ok({ ...initial.data, root: '/old' }));
  await old;
  expect(settings.workspaceDraft?.root).toBe('/new');
});

test('late note navigation cannot repopulate an article after returning to the index', async () => {
  const held = Promise.withResolvers<IpcResult<Note>>();
  const api = fakeApi({ notes: { get: () => held.promise } });
  Object.assign(window, { taskpilot: api });
  const store = useNotesStore();
  const opening = store.goNote('old.md');
  await Promise.resolve();
  await store.goIndex();
  held.resolve({
    ok: true,
    data: {
      id: 'old.md',
      title: 'Old',
      body: 'Old body',
      category: null,
      course: null,
      concepts: [],
      tags: [],
      inlineTags: [],
      source: null,
      summary: null,
      summaryStale: false,
      links: [],
      excerpt: '',
      createdAt: '',
      updatedAt: '',
      version: 'old',
      frontmatterError: false,
    },
  });
  await opening;
  expect(store.route.name).toBe('index');
  expect(store.current).toBeNull();
});

test('a completed requirement action updates its list without replacing a newer selection', async () => {
  const first = requirement({ id: 'first' });
  const second = requirement({ id: 'second' });
  const held = Promise.withResolvers<IpcResult<Requirement>>();
  const api = fakeApi({ requirements: { list: () => ok([first, second]), clarify: () => held.promise } });
  Object.assign(window, { taskpilot: api });
  const store = useRequirementsStore();
  onTestFinished(() => store.stopWatching());
  await store.refreshList();
  store.select(first.id);
  const action = store.runStep(first, 'clarify');
  store.select(second.id);
  held.resolve({ ok: true, data: { ...first, status: 'clarifying' } });
  await action;
  expect(store.current?.id).toBe(second.id);
  expect(store.items.find((item) => item.id === first.id)?.status).toBe('clarifying');
});

test('coding presence drops old-repository runs even without a new state event', async () => {
  const api = executionApi({ task: taskView() });
  api.coding.active.mockResolvedValue({ ok: true, data: [] });
  const store = useCodingActivityStore();
  onTestFinished(() => store.stop());
  store.runs = [{ packageId: 'old-task', title: 'Old repository', label: '编码中', since: null }];
  store.start();
  useRepositoryIdentityStore().currentId = 'new';
  await flushPromises();
  expect(store.runs).toEqual([]);
});
