// @vitest-environment happy-dom
import { beforeEach, expect, test, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

import * as feedback from '@/lib/feedback.ts';
import { useAppStore } from '@/stores/app.ts';
import { useSettingsStore } from '@/stores/settings.ts';
import { useSetupStore } from '@/stores/setup.ts';
import { fail, installApi, ok, workspaceView } from '../settings_fakes.ts';
import { PROGRAMMING_COURSE } from '@shared/course_pack.ts';
import { defaultAgentSettings } from '@shared/agent_runtime.ts';
import type { CliModelCatalog } from '@shared/agent_runtime.ts';
import type { IpcResult } from '@shared/ipc/envelope.ts';

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
  expect(settings.workspaceDraft?.steps.test).toMatchObject({ lines: ['npm test'], mode: 'override' });
  expect(settings.workspaceDraft?.steps.lint).toMatchObject({ lines: [], mode: 'inherit' });
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
  settings.workspaceDraft!.steps.lint = { ...settings.workspaceDraft!.steps.lint!, mode: 'override', lines: ['eslint .'] };
  expect(settings.dirtyPages.commands).toBe(true);
  expect(settings.dirtyPages.repository).toBe(false);
  expect(settings.savebarText).toBe('个人与偏好、工作区有未保存的修改');
  settings.discardAll();
  expect(settings.anyDirty).toBe(false);
  expect(settings.savebarText).toBe('');
});
test('agent configs save independently, reload, and expose runtime status without model calls', async () => {
  const settings = await loaded();
  await settings.openPage('agents');
  await Promise.resolve();
  expect(api.agent.runtimes).toHaveBeenCalledTimes(1);
  settings.setAgentModel('qa', 'provider/test-model');
  expect(settings.preferencesDraft!.agents.architect.model).toBe('');
  expect(settings.dirtyPages.agents).toBe(true);
  expect(settings.dirtyPages.profile).toBe(false);
  expect(await settings.saveAll()).toBe(true);
  expect(api.preferences.set).toHaveBeenCalledWith({
    profile: { displayName: 'Ada', avatarColor: 'ocean' },
    appearance: { theme: 'system', vibrancy: false },
    environment: { pathSource: 'inherit' },
    agents: { ...defaultAgentSettings(), qa: { cli: 'claude', model: 'provider/test-model', thinking: 'default' } },
    coding: { isolation: 'sandbox', extraRead: [], extraWrite: [], timeoutMinutes: 30 },
  });
  await settings.open('agents');
  expect(settings.preferencesDraft!.agents.qa.model).toBe('provider/test-model');
  expect(settings.hasUnsavedChanges()).toBe(false);
});

test('changing CLI explicitly resets unsupported thinking and explains the reset', async () => {
  const settings = await loaded();
  settings.preferencesDraft!.agents.qa.thinking = 'max';
  settings.setAgentCli('qa', 'grok');
  expect(settings.preferencesDraft!.agents.qa).toEqual({ cli: 'grok', model: '', thinking: 'default' });
  expect(settings.agentConfigNotices.qa).toContain('已重置为默认');
});

test('a refreshed native catalog wins over an older in-flight read', async () => {
  const settings = await loaded();
  const oldRead = Promise.withResolvers<IpcResult<CliModelCatalog>>();
  api.agent.models.mockReturnValueOnce(oldRead.promise);
  const first = settings.loadAgentModels('qa');
  const refreshed: CliModelCatalog = {
    cli: 'claude',
    scope: 'analysis',
    models: [{ id: 'new-native', label: 'New native', provider: null, variants: [], source: 'config' }],
    defaultModel: 'new-native',
    defaultThinking: null,
    issues: [],
  };
  api.agent.models.mockReturnValueOnce(ok(refreshed));
  await settings.loadAgentModels('qa', true);
  oldRead.resolve({ ok: true, data: { ...refreshed, models: [], defaultModel: 'old-native' } });
  await first;
  expect(settings.modelsForAgent('qa')?.defaultModel).toBe('new-native');
  expect(settings.modelsForAgent('qa')?.models.map((option) => option.id)).toEqual(['new-native']);
});

test('coding and analysis roles do not share catalog credentials or defaults', async () => {
  const settings = await loaded();
  settings.setAgentCli('coding-agent', 'claude');
  await settings.loadAgentModels('coding-agent');
  const analysis: CliModelCatalog = { cli: 'claude', scope: 'analysis', models: [], defaultModel: 'main-user-native', defaultThinking: null, issues: [] };
  api.agent.models.mockReturnValueOnce(ok(analysis));
  await settings.loadAgentModels('qa');
  expect(settings.modelsForAgent('qa')?.defaultModel).toBe('main-user-native');
  expect(settings.modelsForAgent('coding-agent')?.defaultModel).not.toBe('main-user-native');
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
  settings.workspaceDraft!.steps.lint = { ...settings.workspaceDraft!.steps.lint!, mode: 'override', lines: [' eslint . ', ''] };
  settings.workspaceDraft!.steps.coverage = { ...settings.workspaceDraft!.steps.coverage!, mode: 'off' };
  settings.preferencesDraft!.appearance.theme = 'dark';
  expect(await settings.saveAll()).toBe(true);
  expect(api.workspace.check).toHaveBeenCalledBefore(api.workspace.set);
  const form = api.workspace.set.mock.calls[0][0];
  expect(form.root).toBe('/repo');
  // Only steps this machine sets are sent; one left to the project is not.
  expect(Object.keys(form.steps).sort()).toEqual(['coverage', 'lint', 'test']);
  expect(form.steps.lint).toMatchObject({ enabled: true, lines: ['eslint .'], stage: 'step', blocking: false });
  expect(form.steps.coverage).toMatchObject({ enabled: false, lines: [] });
  expect(form.steps.test?.lines).toEqual(['npm test']);
  expect(api.preferences.set).toHaveBeenCalledWith({
    profile: { displayName: 'Ada', avatarColor: 'ocean' },
    appearance: { theme: 'dark', vibrancy: false },
    environment: { pathSource: 'inherit' },
    agents: defaultAgentSettings(),
    coding: { isolation: 'sandbox', extraRead: [], extraWrite: [], timeoutMinutes: 30 },
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
  settings.workspaceDraft!.steps.build = { ...settings.workspaceDraft!.steps.build!, mode: 'override', lines: ['make | tee'] };
  api.workspace.check.mockReturnValueOnce(fail('shell_syntax', 'steps.build.commands[0]: command uses shell syntax "|"', 'steps.build.commands[0]'));
  expect(await settings.saveAll()).toBe(false);
  expect(api.workspace.set).not.toHaveBeenCalled();
  expect(settings.activePage).toBe('commands');
  expect(settings.statuses.build).toEqual({ tone: 'error', message: 'steps.build.commands[0]: command uses shell syntax "|"' });
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
  expect(settings.statuses.lint).toEqual({ tone: null, message: '未配置，会跳过' });
  expect(settings.repoFacts).toEqual([
    { term: '分支', value: 'main' },
    { term: '当前提交', value: 'abcdef123456' },
    { term: '工作区状态', value: '干净' },
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
  expect(feedback.confirmChoice).toHaveBeenCalledWith({
    title: '保存修改？',
    body: '设置里有未保存的修改。离开后这些修改会丢失。',
    accept: '保存',
    alternate: '不保存',
  });
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
  settings.workspaceDraft!.steps.test!.lines = ['npm run unit'];
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

test('confirmCourse() shows the pending pack and confirms it with the hash shown', async () => {
  const ref = { id: 'os', version: '0.1.0', contentHash: 'b'.repeat(64), source: 'repository' as const };
  const pack = { ...PROGRAMMING_COURSE, id: 'os', title: '操作系统实验', summary: '在教学内核里动手。' };
  const pending = workspaceView({ course: { ...workspaceView().course, selected: { id: 'os', from: 'project' }, state: { status: 'pending', pack, ref } } });
  api.workspace.get.mockReturnValue(ok(pending));
  const settings = await loaded();

  vi.mocked(feedback.confirmAction).mockResolvedValueOnce(false);
  await settings.confirmCourse();
  expect(api.workspace.confirmCourse).not.toHaveBeenCalled();

  vi.mocked(feedback.confirmAction).mockResolvedValueOnce(true);
  await settings.confirmCourse();
  const shown = vi.mocked(feedback.confirmAction).mock.calls[1][0];
  expect(shown.title).toContain('操作系统实验');
  expect(shown.body).toContain('.taskpilot/courses/os.toml');
  expect(shown.body).toContain('思路（thinking）');
  expect(api.workspace.confirmCourse).toHaveBeenCalledWith('os', 'b'.repeat(64));
  expect(settings.workspaceView?.course.state).toEqual({ status: 'ok' });
});
