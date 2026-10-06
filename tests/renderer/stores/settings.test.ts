// @vitest-environment happy-dom
import { beforeEach, expect, test, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

import * as feedback from '@/lib/feedback.ts';
import { useAppStore } from '@/stores/app.ts';
import { useSettingsStore } from '@/stores/settings.ts';
import { useSetupStore } from '@/stores/setup.ts';
import { fail, installApi } from '../settings_fakes.ts';

vi.mock('@/lib/feedback.ts', () => ({ showToast: vi.fn(), confirmAction: vi.fn(), confirmChoice: vi.fn(), openDialogs: { value: 0 } }));

let api: ReturnType<typeof installApi>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  api = installApi();
  setActivePinia(createPinia());
});

const loaded = async () => {
  const settings = useSettingsStore();
  await settings.open('profile');
  return settings;
};

test('open() navigates to settings and loads both stores', async () => {
  const settings = await loaded();
  expect(useAppStore().view).toBe('settings');
  expect(settings.activePage).toBe('profile');
  expect(settings.preferencesDraft?.profile.displayName).toBe('Ada');
  expect(settings.workspaceDraft?.commands.test).toBe('npm test');
  expect(settings.hasUnsavedChanges()).toBe(false);
});

test('open() keeps pending edits instead of reloading', async () => {
  const settings = await loaded();
  settings.preferencesDraft!.profile.displayName = 'Grace';
  await settings.open('repository');
  expect(api.preferences.get).toHaveBeenCalledTimes(1);
  expect(settings.preferencesDraft?.profile.displayName).toBe('Grace');
  expect(settings.activePage).toBe('repository');
});

test('edits mark exactly their page dirty and label the save bar', async () => {
  const settings = await loaded();
  settings.preferencesDraft!.profile.avatarColor = 'forest';
  expect(settings.dirtyPages.profile).toBe(true);
  expect(settings.dirtyPages.preferences).toBe(false);
  expect(settings.savebarText).toBe('个人与偏好有未保存的修改');
  settings.workspaceDraft!.commands.lint = 'eslint .';
  expect(settings.dirtyPages.commands).toBe(true);
  expect(settings.dirtyPages.repository).toBe(false);
  expect(settings.savebarText).toBe('个人与偏好、工作区有未保存的修改');
  settings.discardAll();
  expect(settings.anyDirty).toBe(false);
  expect(settings.savebarText).toBe('');
});

test('search filters pages, hides empty groups, and moves off a hidden page', async () => {
  const settings = await loaded();
  settings.search('PATH');
  expect([...settings.visiblePages]).toEqual(['environment']);
  expect(settings.visibleGroups).toEqual(['device']);
  expect(settings.activePage).toBe('environment');
  settings.search('不存在的设置');
  expect(settings.visiblePages.size).toBe(0);
  // Nothing matches: the open page stays put.
  expect(settings.activePage).toBe('environment');
  settings.search('');
  expect(settings.visibleGroups).toEqual(['personal', 'workspace', 'device']);
});

test('save checks the workspace, then sends each dirty store in form shape', async () => {
  const settings = await loaded();
  settings.workspaceDraft!.commands.lint = 'eslint .';
  settings.preferencesDraft!.appearance.theme = 'dark';
  expect(await settings.saveAll()).toBe(true);
  expect(api.workspace.check).toHaveBeenCalledBefore(api.workspace.set);
  const form = api.workspace.set.mock.calls[0][0];
  expect(form.root).toBe('/repo');
  expect(form.commands).toEqual({ test: 'npm test', lint: 'eslint .', build: '', smoke: '' });
  expect(api.preferences.set).toHaveBeenCalledWith({
    profile: { displayName: 'Ada', avatarColor: 'ocean' },
    appearance: { theme: 'dark', vibrancy: false },
    environment: { pathSource: 'inherit' },
  });
  expect(api.workspace.info).toHaveBeenCalled();
  expect(useAppStore().preferences?.appearance.theme).toBe('dark');
  expect(settings.hasUnsavedChanges()).toBe(false);
  expect(feedback.showToast).toHaveBeenCalledWith('设置已保存。');
});

test('a clean save writes nothing', async () => {
  const settings = await loaded();
  expect(await settings.saveAll()).toBe(true);
  expect(api.workspace.set).not.toHaveBeenCalled();
  expect(api.preferences.set).not.toHaveBeenCalled();
});

test('a failed check shows the error on its field and writes nothing', async () => {
  const settings = await loaded();
  settings.workspaceDraft!.commands.build = 'make | tee';
  api.workspace.check.mockReturnValueOnce(fail('shell_syntax', 'shell syntax', 'build'));
  expect(await settings.saveAll()).toBe(false);
  expect(api.workspace.set).not.toHaveBeenCalled();
  expect(settings.activePage).toBe('commands');
  expect(settings.statuses.build).toEqual({ tone: 'error', message: '不支持 shell 语法，请改用 package.json 脚本。' });
  expect(settings.hasUnsavedChanges()).toBe(true);
});

test('an error without a known field becomes a toast', async () => {
  const settings = await loaded();
  settings.preferencesDraft!.profile.displayName = 'Grace';
  api.preferences.set.mockReturnValueOnce(fail('weird', 'boom'));
  expect(await settings.saveAll()).toBe(false);
  expect(feedback.showToast).toHaveBeenCalledWith('设置无效：boom');
});

test('the workspace check shows resolved commands and repo facts', async () => {
  const settings = await loaded();
  expect(await settings.checkWorkspace()).toBe(true);
  expect(settings.statuses.root).toEqual({ tone: 'ok', message: '这是一个 git 仓库' });
  expect(settings.statuses.test).toEqual({ tone: 'ok', message: '/usr/local/bin/npm' });
  expect(settings.statuses.lint).toEqual({ tone: null, message: '未配置' });
  expect(settings.repoFacts).toEqual([
    { term: '分支', value: 'main' }, { term: '当前提交', value: 'abcdef123456' }, { term: '工作区状态', value: '干净' },
  ]);
});

test('a name over 40 characters is flagged as you type', async () => {
  const settings = await loaded();
  settings.preferencesDraft!.profile.displayName = 'x'.repeat(41);
  settings.checkNameLength();
  expect(settings.statuses.displayName).toEqual({ tone: 'error', message: '最多 40 个字符' });
});

test('leaving clean settings does not ask', async () => {
  await loaded();
  expect(await useAppStore().navigate('queue')).toBe(true);
  expect(feedback.confirmChoice).not.toHaveBeenCalled();
});

test('leave guard: 保存 saves before leaving', async () => {
  const settings = await loaded();
  settings.preferencesDraft!.profile.displayName = 'Grace';
  vi.mocked(feedback.confirmChoice).mockResolvedValueOnce('accept');
  expect(await useAppStore().navigate('queue')).toBe(true);
  expect(feedback.confirmChoice).toHaveBeenCalledWith({ title: '保存修改？', body: '设置里有未保存的修改。离开后这些修改会丢失。', accept: '保存', alternate: '不保存' });
  expect(api.preferences.set).toHaveBeenCalled();
  expect(useAppStore().view).toBe('queue');
});

test('leave guard: a failed save keeps you in settings', async () => {
  const settings = await loaded();
  settings.preferencesDraft!.profile.displayName = 'Grace';
  api.preferences.set.mockReturnValueOnce(fail('invalid_name', 'bad', 'displayName'));
  vi.mocked(feedback.confirmChoice).mockResolvedValueOnce('accept');
  expect(await useAppStore().navigate('queue')).toBe(false);
  expect(useAppStore().view).toBe('settings');
});

test('leave guard: 不保存 discards the drafts and leaves', async () => {
  const settings = await loaded();
  settings.preferencesDraft!.profile.displayName = 'Grace';
  vi.mocked(feedback.confirmChoice).mockResolvedValueOnce('alternate');
  expect(await useAppStore().navigate('queue')).toBe(true);
  expect(api.preferences.set).not.toHaveBeenCalled();
  expect(settings.preferencesDraft?.profile.displayName).toBe('Ada');
});

test('leave guard: dismissing stays with the edits', async () => {
  const settings = await loaded();
  settings.preferencesDraft!.profile.displayName = 'Grace';
  vi.mocked(feedback.confirmChoice).mockResolvedValueOnce(false);
  expect(await useAppStore().navigate('queue')).toBe(false);
  expect(useAppStore().view).toBe('settings');
  expect(settings.preferencesDraft?.profile.displayName).toBe('Grace');
});

test('reset asks first and does nothing when declined', async () => {
  const settings = await loaded();
  vi.mocked(feedback.confirmAction).mockResolvedValueOnce(false);
  await settings.resetProgress();
  expect(feedback.confirmAction).toHaveBeenCalledWith(expect.objectContaining({ title: '重置工作包进度？', accept: '重置进度', danger: true }));
  expect(api.data.resetProgress).not.toHaveBeenCalled();
});

test('a confirmed reset clears progress and reloads the queue and data', async () => {
  const settings = await loaded();
  vi.mocked(feedback.confirmAction).mockResolvedValueOnce(true);
  await settings.resetProgress();
  expect(api.data.resetProgress).toHaveBeenCalled();
  expect(api.listTasks).toHaveBeenCalled();
  expect(api.data.info).toHaveBeenCalled();
  expect(feedback.showToast).toHaveBeenCalledWith('工作包进度已重置。');
});

test('opening the environment page previews the draft PATH source', async () => {
  const settings = await loaded();
  settings.preferencesDraft!.environment.pathSource = 'login-shell';
  settings.openPage('environment');
  await vi.waitFor(() => expect(settings.environment).not.toBeNull());
  expect(api.environment.info).toHaveBeenCalledWith({ source: 'login-shell', refresh: false });
  expect(api.environment.info).toHaveBeenCalledWith({ source: 'inherit' });
});

test('setup cannot apply commands over unsaved settings edits', async () => {
  const settings = await loaded();
  const setup = useSetupStore();
  settings.openPage('setup');
  await vi.waitFor(() => expect(setup.view).not.toBeNull());
  setup.selectedKinds = ['test'];
  settings.workspaceDraft!.commands.test = 'npm run unit';
  expect(await setup.apply()).toBe(false);
  expect(api.env.apply).not.toHaveBeenCalled();
  expect(feedback.showToast).toHaveBeenCalledWith('设置里还有未保存的修改，请先保存或放弃。', 'error');
});

test('applying commands reloads settings from disk', async () => {
  const settings = await loaded();
  const setup = useSetupStore();
  setup.selectedKinds = ['test'];
  expect(await setup.apply()).toBe(true);
  expect(api.env.apply).toHaveBeenCalledWith(['test']);
  expect(api.workspace.get).toHaveBeenCalledTimes(2);
  expect(settings.hasUnsavedChanges()).toBe(false);
});
