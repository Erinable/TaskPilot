// @vitest-environment happy-dom
import { beforeEach, expect, test, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises } from '@vue/test-utils';
import { reactive } from 'vue';

import * as feedback from '@/lib/feedback.ts';
import { useAppStore } from '@/stores/app.ts';
import { useSettingsStore } from '@/stores/settings.ts';
import { useSetupStore } from '@/stores/setup.ts';
import { useRepositoryIdentityStore } from '@/stores/repository_identity.ts';
import { fail, installApi, ok, preferences } from '../settings_fakes.ts';
import { expectConsole } from '../../fixtures/expected_console.ts';
import { defaultAgentSettings } from '@shared/agent_runtime.ts';
import type { CliModelCatalog } from '@shared/agent_runtime.ts';
import type { IpcResult } from '@shared/ipc/envelope.ts';
import type { WorkspaceCheck, WorkspaceView } from '@shared/ipc/workspace.ts';
import type { Preferences } from '@shared/ipc/settings.ts';

vi.mock('@/lib/feedback.ts', () => ({ showToast: vi.fn(), confirmAction: vi.fn(), confirmChoice: vi.fn(), openDialogs: { value: 0 } }));

let api: ReturnType<typeof installApi>;

beforeEach(() => {
  vi.clearAllMocks();
  api = installApi();
  setActivePinia(createPinia());
});

const loaded = async () => {
  const settings = useSettingsStore();
  await settings.open('profile');
  return settings;
};

test('saving detaches independently reactive settings nodes for IPC', async () => {
  const settings = await loaded();
  const folders = reactive(['/repo/read']);
  const agent = reactive({ cli: 'claude' as const, model: 'provider/nested', thinking: 'high' as const });
  const lines = reactive([' npm run lint ']);
  const parser = reactive({ format: 'regex' as const, pattern: '(?<message>.*)', severity: 'warning' as const });
  settings.preferencesDraft!.coding.extraRead = folders;
  settings.preferencesDraft!.agents.qa = agent;
  settings.workspaceDraft!.steps.lint = reactive({ ...settings.workspaceDraft!.steps.lint!, mode: 'override' as const, lines, parser });
  expect(await settings.saveAll()).toBe(true);
  const preferences = api.preferences.set.mock.calls[0][0];
  const workspace = api.workspace.set.mock.calls[0][0];
  expect(structuredClone(preferences).agents.qa.model).toBe('provider/nested');
  expect(structuredClone(workspace).steps.lint?.parser).toEqual({ format: 'regex', pattern: '(?<message>.*)', severity: 'warning' });
  expect(structuredClone(api.workspace.check.mock.calls[0][0])).toEqual(workspace);
  folders.push('/later');
  agent.model = 'provider/later';
  parser.pattern = 'later';
  lines.push('later');
  expect(preferences.coding.extraRead).toEqual(['/repo/read']);
  expect(preferences.agents.qa.model).toBe('provider/nested');
  expect(workspace.steps.lint?.lines).toEqual(['npm run lint']);
  expect(workspace.steps.lint?.parser).toEqual({ format: 'regex', pattern: '(?<message>.*)', severity: 'warning' });
});

test('discarded drafts never share mutable arrays or parser objects with saved settings', async () => {
  const settings = await loaded();
  settings.preferencesDraft!.coding.extraRead.push('/discard');
  settings.workspaceDraft!.steps.test!.lines.push('npm run extra');
  settings.workspaceDraft!.steps.test!.parser = { format: 'junit', path: 'report.xml' };
  settings.discardAll();
  expect(settings.preferencesDraft!.coding.extraRead).toEqual([]);
  expect(settings.workspaceDraft!.steps.test!.lines).toEqual(['npm test']);
  expect(settings.workspaceDraft!.steps.test!.parser).toEqual({ format: 'tests' });
  settings.preferencesDraft!.coding.extraRead.push('/another edit');
  expect(settings.savedPreferences!.coding.extraRead).toEqual([]);
});

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

test('a slow preferences save keeps later input dirty and a later explicit save persists it', async () => {
  const settings = await loaded();
  settings.preferencesDraft!.profile.displayName = 'Submitted';
  const held = Promise.withResolvers<IpcResult<Preferences>>();
  const persist = api.preferences.set.getMockImplementation()!;
  api.preferences.set.mockReturnValueOnce(held.promise);
  const saving = settings.saveAll();
  expect(settings.saving).toBe(true);
  settings.preferencesDraft!.profile.displayName = 'Later input';
  settings.preferencesDraft!.coding.extraRead.push('/later');
  const submitted = api.preferences.set.mock.calls[0][0];
  expect(submitted.profile.displayName).toBe('Submitted');
  expect(submitted.coding.extraRead).toEqual([]);
  held.resolve(await persist(submitted));
  expect(await saving).toBe(false);
  expect(settings.saving).toBe(false);
  expect(settings.savedPreferences!.profile.displayName).toBe('Submitted');
  expect(settings.preferencesDraft!.profile.displayName).toBe('Later input');
  expect(settings.preferencesDraft!.coding.extraRead).toEqual(['/later']);
  expect(settings.hasUnsavedChanges()).toBe(true);
  expect(await settings.saveAll()).toBe(true);
  expect(api.preferences.set).toHaveBeenCalledTimes(2);
  expect(settings.savedPreferences!.profile.displayName).toBe('Later input');
  expect(settings.hasUnsavedChanges()).toBe(false);
});

test('concurrent saves share one write and report pending later edits to every caller', async () => {
  const settings = await loaded();
  settings.preferencesDraft!.profile.displayName = 'Submitted';
  const held = Promise.withResolvers<IpcResult<Preferences>>();
  api.preferences.set.mockReturnValueOnce(held.promise);
  const first = settings.saveAll();
  settings.preferencesDraft!.profile.displayName = 'Later input';
  const second = settings.saveAll();
  const third = settings.saveAll();
  expect(api.preferences.set).toHaveBeenCalledTimes(1);
  held.resolve({ ok: true, data: { ...preferences(), profile: { ...preferences().profile, displayName: 'Submitted' } } });
  expect(await Promise.all([first, second, third])).toEqual([false, false, false]);
  expect(settings.preferencesDraft!.profile.displayName).toBe('Later input');
  expect(settings.hasUnsavedChanges()).toBe(true);
});

test('workspace validation and save use the same snapshot and snapshot preferences before validation', async () => {
  const settings = await loaded();
  settings.workspaceDraft!.steps.test!.lines = ['npm run submitted'];
  settings.preferencesDraft!.profile.displayName = 'Submitted';
  const checked = await api.workspace.check({ root: '/repo', steps: {} });
  api.workspace.check.mockClear();
  const held = Promise.withResolvers<IpcResult<WorkspaceCheck>>();
  api.workspace.check.mockReturnValueOnce(held.promise);
  const first = settings.saveAll();
  settings.workspaceDraft!.steps.test!.lines = ['npm run later'];
  settings.preferencesDraft!.profile.displayName = 'Later input';
  const second = settings.saveAll();
  expect(api.workspace.check).toHaveBeenCalledTimes(1);
  expect(api.workspace.set).not.toHaveBeenCalled();
  held.resolve(checked);
  expect(await Promise.all([first, second])).toEqual([false, false]);
  expect(api.workspace.set).toHaveBeenCalledTimes(1);
  expect(api.workspace.set.mock.calls[0][0]).toBe(api.workspace.check.mock.calls[0][0]);
  expect(api.workspace.set.mock.calls[0][0].steps.test!.lines).toEqual(['npm run submitted']);
  expect(api.preferences.set.mock.calls[0][0].profile.displayName).toBe('Submitted');
  expect(settings.savedWorkspace!.steps.test!.lines).toEqual(['npm run submitted']);
  expect(settings.workspaceDraft!.steps.test!.lines).toEqual(['npm run later']);
  expect(settings.preferencesDraft!.profile.displayName).toBe('Later input');
  expect(settings.dirty).toEqual({ workspace: true, preferences: true });
});

test('a slow workspace write keeps changes made after validation and later edits to a previously clean store', async () => {
  const settings = await loaded();
  settings.workspaceDraft!.steps.test!.lines = ['npm run submitted'];
  const persist = api.workspace.set.getMockImplementation()!;
  const held = Promise.withResolvers<IpcResult<WorkspaceView>>();
  api.workspace.set.mockReturnValueOnce(held.promise);
  const saving = settings.saveAll();
  await flushPromises();
  settings.workspaceDraft!.steps.test!.lines.push('npm run later');
  settings.preferencesDraft!.profile.displayName = 'Later input';
  held.resolve(await persist(api.workspace.set.mock.calls[0][0]));
  expect(await saving).toBe(false);
  expect(settings.savedWorkspace!.steps.test!.lines).toEqual(['npm run submitted']);
  expect(settings.workspaceDraft!.steps.test!.lines).toEqual(['npm run submitted', 'npm run later']);
  expect(api.preferences.set).not.toHaveBeenCalled();
  expect(settings.dirty).toEqual({ workspace: true, preferences: true });
});

test('the leave guard stays in settings when input continues during its save', async () => {
  const settings = await loaded();
  settings.preferencesDraft!.profile.displayName = 'Submitted';
  const held = Promise.withResolvers<IpcResult<Preferences>>();
  api.preferences.set.mockReturnValueOnce(held.promise);
  const saving = settings.saveAll();
  vi.mocked(feedback.confirmChoice).mockResolvedValueOnce('accept');
  const leaving = useAppStore().navigate('queue');
  await flushPromises();
  settings.preferencesDraft!.profile.displayName = 'Later input';
  held.resolve({ ok: true, data: { ...preferences(), profile: { ...preferences().profile, displayName: 'Submitted' } } });
  expect(await saving).toBe(false);
  expect(await leaving).toBe(false);
  expect(api.preferences.set).toHaveBeenCalledTimes(1);
  expect(useAppStore().view).toBe('settings');
  expect(settings.preferencesDraft!.profile.displayName).toBe('Later input');
});

test('partial save failure advances only the successful baseline and preserves all later input for retry', async () => {
  expectConsole('error', /preferences write failed/);
  const settings = await loaded();
  settings.workspaceDraft!.steps.test!.lines = ['npm run submitted'];
  settings.preferencesDraft!.profile.displayName = 'Submitted';
  const held = Promise.withResolvers<IpcResult<Preferences>>();
  api.preferences.set.mockReturnValueOnce(held.promise);
  const saving = settings.saveAll();
  await flushPromises();
  expect(settings.savedWorkspace!.steps.test!.lines).toEqual(['npm run submitted']);
  settings.workspaceDraft!.steps.test!.lines = ['npm run later'];
  settings.preferencesDraft!.profile.displayName = 'Later input';
  held.resolve({ ok: false, error: { code: 'unknown', message: 'preferences write failed' } });
  expect(await saving).toBe(false);
  expect(settings.savedPreferences!.profile.displayName).toBe('Ada');
  expect(settings.preferencesDraft!.profile.displayName).toBe('Later input');
  expect(settings.workspaceDraft!.steps.test!.lines).toEqual(['npm run later']);
  expect(settings.dirty).toEqual({ preferences: true, workspace: true });
  expect(settings.saving).toBe(false);
  expect(await settings.saveAll()).toBe(true);
  expect(settings.hasUnsavedChanges()).toBe(false);
});

test('a failed workspace write preserves both drafts and never starts a preferences write', async () => {
  expectConsole('error', /workspace write failed/);
  const settings = await loaded();
  settings.workspaceDraft!.steps.test!.lines = ['npm run submitted'];
  settings.preferencesDraft!.profile.displayName = 'Submitted';
  const held = Promise.withResolvers<IpcResult<WorkspaceView>>();
  api.workspace.set.mockReturnValueOnce(held.promise);
  const saving = settings.saveAll();
  await flushPromises();
  settings.workspaceDraft!.steps.test!.lines = ['npm run later'];
  held.resolve({ ok: false, error: { code: 'unknown', message: 'workspace write failed' } });
  expect(await saving).toBe(false);
  expect(api.preferences.set).not.toHaveBeenCalled();
  expect(settings.savedWorkspace!.steps.test!.lines).toEqual(['npm test']);
  expect(settings.workspaceDraft!.steps.test!.lines).toEqual(['npm run later']);
  expect(settings.preferencesDraft!.profile.displayName).toBe('Submitted');
  expect(settings.dirty).toEqual({ preferences: true, workspace: true });
});

test.each(['check', 'set'] as const)('switching repositories during workspace %s rejects stale replies and skips remaining writes', async (stage) => {
  const settings = await loaded();
  settings.workspaceDraft!.steps.test!.lines = ['npm run old'];
  settings.preferencesDraft!.profile.displayName = 'Old repository draft';
  const view = await api.workspace.get();
  const checked = await api.workspace.check({ root: '/repo', steps: {} });
  api.workspace.check.mockClear();
  const heldCheck = Promise.withResolvers<IpcResult<WorkspaceCheck>>();
  const heldSet = Promise.withResolvers<IpcResult<WorkspaceView>>();
  if (stage === 'check') api.workspace.check.mockReturnValueOnce(heldCheck.promise);
  else api.workspace.set.mockReturnValueOnce(heldSet.promise);
  const saving = settings.saveAll();
  await flushPromises();
  useRepositoryIdentityStore().currentId = 'new-repository';
  if (!view.ok) throw new Error('Expected workspace fixture');
  api.workspace.get.mockReturnValueOnce(ok({ ...view.data, root: '/new-repository' }));
  await settings.load();
  settings.preferencesDraft!.profile.displayName = 'New repository draft';
  heldCheck.resolve(checked);
  heldSet.resolve(view);
  expect(await saving).toBe(false);
  expect(api.workspace.set).toHaveBeenCalledTimes(stage === 'check' ? 0 : 1);
  expect(api.preferences.set).not.toHaveBeenCalled();
  expect(settings.savedWorkspace!.root).toBe('/new-repository');
  expect(settings.workspaceDraft!.root).toBe('/new-repository');
  expect(settings.workspaceView!.root).toBe('/new-repository');
  expect(settings.preferencesDraft!.profile.displayName).toBe('New repository draft');
  expect(settings.repoFacts).toBeNull();
  expect(feedback.showToast).not.toHaveBeenCalledWith('设置已保存。');
});

test.each([null, 'new-repository'])('a preferences reply from an older load cannot overwrite reloaded drafts (%s)', async (repositoryId) => {
  const settings = await loaded();
  settings.preferencesDraft!.profile.displayName = 'Old save';
  const held = Promise.withResolvers<IpcResult<Preferences>>();
  api.preferences.set.mockReturnValueOnce(held.promise);
  const saving = settings.saveAll();
  useRepositoryIdentityStore().currentId = repositoryId;
  await settings.load();
  settings.preferencesDraft!.profile.displayName = 'New draft';
  held.resolve({ ok: true, data: { ...preferences(), profile: { ...preferences().profile, displayName: 'Old save' } } });
  expect(await saving).toBe(false);
  expect(settings.savedPreferences!.profile.displayName).toBe('Ada');
  expect(settings.preferencesDraft!.profile.displayName).toBe('New draft');
  expect(useAppStore().preferences).toBeNull();
});

test('saving while a repository is loading cannot submit the previous repository drafts', async () => {
  const settings = await loaded();
  settings.workspaceDraft!.root = '/old-edit';
  settings.preferencesDraft!.profile.displayName = 'Old draft';
  const view = await api.workspace.get();
  const held = Promise.withResolvers<IpcResult<WorkspaceView>>();
  useRepositoryIdentityStore().currentId = 'new-repository';
  api.workspace.get.mockReturnValueOnce(held.promise);
  const loading = settings.load();
  expect(await settings.saveAll()).toBe(false);
  expect(await settings.checkWorkspace()).toBe(false);
  expect(api.workspace.check).not.toHaveBeenCalled();
  expect(api.workspace.set).not.toHaveBeenCalled();
  expect(api.preferences.set).not.toHaveBeenCalled();
  held.resolve(view);
  await loading;
  settings.preferencesDraft!.profile.displayName = 'New draft';
  expect(await settings.saveAll()).toBe(true);
  expect(api.preferences.set.mock.calls[0][0].profile.displayName).toBe('New draft');
});

test('a failed check shows the error on its field and writes nothing', async () => {
  expectConsole('error', /shell syntax/);
  const settings = await loaded();
  settings.workspaceDraft!.steps.build = { ...settings.workspaceDraft!.steps.build!, mode: 'override', lines: ['make | tee'] };
  api.workspace.check.mockReturnValueOnce(fail('shell_syntax', 'steps.build.commands[0]: command uses shell syntax "|"', 'steps.build.commands[0]'));
  expect(await settings.saveAll()).toBe(false);
  expect(api.workspace.set).not.toHaveBeenCalled();
  expect(settings.activePage).toBe('commands');
  expect(settings.statuses.build).toEqual({ tone: 'error', message: 'steps.build.commands[0]: command uses shell syntax "|"' });
  expect(settings.hasUnsavedChanges()).toBe(true);
});

test('a page that finishes loading after leaving settings does not steal focus', async () => {
  expectConsole('error', /Invalid model identifier/);
  const settings = await loaded();
  settings.preferencesDraft!.agents['product-lead'].model = '--bad';
  api.preferences.set.mockReturnValueOnce(fail('invalid_choice', 'Invalid model identifier', 'agents.product-lead.model'));
  expect(await settings.saveAll()).toBe(false);
  vi.mocked(feedback.confirmChoice).mockResolvedValueOnce('alternate');
  await useAppStore().navigate('queue');
  const input = document.createElement('input');
  input.id = 'agent-product-lead-model';
  document.body.append(input);
  try {
    await settings.focusPendingField('agents');
    expect(document.activeElement).not.toBe(input);
  } finally {
    input.remove();
  }
});

test('an error without a known field becomes a toast', async () => {
  expectConsole('error', /IpcError: boom/);
  const settings = await loaded();
  settings.preferencesDraft!.profile.displayName = 'Grace';
  api.preferences.set.mockReturnValueOnce(fail('unknown', 'boom'));
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

test.each([
  { choice: 'accept' as const, leaves: true },
  { choice: 'alternate' as const, leaves: true },
  { choice: false as const, leaves: false },
])('leave guard: %s', async ({ choice, leaves }) => {
  const settings = await loaded();
  settings.preferencesDraft!.profile.displayName = 'Grace';
  vi.mocked(feedback.confirmChoice).mockResolvedValueOnce(choice);
  expect(await useAppStore().navigate('queue')).toBe(leaves);

  if (choice === 'accept') {
    expect(useAppStore().preferences?.profile.displayName).toBe('Grace');
  } else if (choice === 'alternate') {
    expect(api.preferences.set).not.toHaveBeenCalled();
    expect(settings.preferencesDraft?.profile.displayName).toBe('Ada');
  } else {
    expect(useAppStore().view).toBe('settings');
    expect(settings.preferencesDraft?.profile.displayName).toBe('Grace');
  }
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
  expect(feedback.showToast).toHaveBeenCalledWith('工作包进度已重置。');
});

test('opening the environment page previews the draft PATH source', async () => {
  const settings = await loaded();
  settings.preferencesDraft!.environment.pathSource = 'login-shell';
  settings.openPage('environment');
  await flushPromises();
  expect(settings.environment).not.toBeNull();
  expect(api.environment.info).toHaveBeenCalledWith({ source: 'login-shell', refresh: false });
  expect(api.environment.info).toHaveBeenCalledWith({ source: 'inherit' });
});

test('setup cannot apply commands over unsaved settings edits', async () => {
  const settings = await loaded();
  const setup = useSetupStore();
  settings.openPage('setup');
  await flushPromises();
  expect(setup.view).not.toBeNull();
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
  expect(settings.hasUnsavedChanges()).toBe(false);
});
