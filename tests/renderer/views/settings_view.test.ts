// @vitest-environment happy-dom
import { beforeEach, expect, onTestFinished, test, vi } from 'vitest';
import { DOMWrapper, flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import ElementPlus from 'element-plus';

// Mounts the whole settings UI with Element Plus per test.
vi.setConfig({ testTimeout: 20_000 });

import * as feedback from '@/lib/feedback.ts';
import SettingsView from '@/views/SettingsView.vue';
import { useSettingsStore } from '@/stores/settings.ts';
import { envState, fail, installApi, ok } from '../settings_fakes.ts';

vi.mock('@/lib/feedback.ts', () => ({ showToast: vi.fn(), confirmAction: vi.fn(), confirmChoice: vi.fn(), openDialogs: { value: 0 } }));

let api: ReturnType<typeof installApi>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  api = installApi();
});

const mountView = async (page: 'profile' | 'commands' | 'setup' | 'agents' = 'profile') => {
  const pinia = createPinia();
  setActivePinia(pinia);
  const wrapper = mount(SettingsView, { global: { plugins: [ElementPlus, pinia] }, attachTo: document.body });
  onTestFinished(() => wrapper.unmount());
  await useSettingsStore().open(page);
  await flushPromises();
  return wrapper;
};

const chooseModel = async (wrapper: Awaited<ReturnType<typeof mountView>>, agent: string, value: string) => {
  await wrapper.get(`[data-agent="${agent}"] .el-select`).trigger('click');
  await wrapper.get(`#agent-${agent}-model`).setValue(value);
  await flushPromises();
  const options = Array.from(document.querySelectorAll<HTMLElement>(`.agent-model-options-${agent} .el-select-dropdown__item`));
  const option = options.find((item) => item.style.display !== 'none' && item.textContent?.trim() === value);
  expect(option).toBeDefined();
  await new DOMWrapper(option!).trigger('click');
  await flushPromises();
};

const isShown = (element: { attributes: (name: string) => string | undefined }) => !(element.attributes('style') ?? '').includes('display: none');
test('agent configuration saves a custom model without changing other roles', async () => {
  const wrapper = await mountView('agents');
  const codex = wrapper.get('#agent-product-lead-cli').find('option[value="codex"]');
  expect(codex.attributes('disabled')).toBeDefined();
  await chooseModel(wrapper, 'product-lead', 'provider/model-x');
  expect(isShown(wrapper.get('#settingsSavebar'))).toBe(true);
  await wrapper.get('#saveSettings').trigger('click');
  await flushPromises();
  await useSettingsStore().load();
  await flushPromises();
  expect(wrapper.get('[data-agent="product-lead"] .el-select__placeholder').text()).toBe('provider/model-x');
  expect(useSettingsStore().preferencesDraft!.agents.qa.model).toBe('');
  expect(isShown(wrapper.get('#settingsSavebar'))).toBe(false);
  wrapper.unmount();
});

test('native CLI catalog selection saves the exact provider/model ID and can return to the native default', async () => {
  const wrapper = await mountView('agents');
  await wrapper.get('#agent-product-lead-cli').setValue('pi');
  await flushPromises();
  await wrapper.get('[data-agent="product-lead"] .el-select').trigger('click');
  await wrapper.get('#agent-product-lead-model').setValue('gateway/native');
  await flushPromises();
  expect(document.querySelector('.agent-model-options-product-lead .model-option-name')?.textContent).toBe('Native Pi model');
  await wrapper.get('#agent-product-lead-model').setValue('Native Pi');
  await flushPromises();
  expect(document.querySelector('.agent-model-options-product-lead .model-option-id')?.textContent).toBe('gateway/native-model');
  await wrapper.get('#agent-product-lead-model').setValue('gateway/native-model');
  await flushPromises();
  const option = document.querySelector<HTMLElement>('.agent-model-options-product-lead .model-option-name');
  expect(option?.textContent).toBe('Native Pi model');
  await new DOMWrapper(option!).trigger('click');
  await wrapper.get('#saveSettings').trigger('click');
  await flushPromises();
  await useSettingsStore().load();
  await flushPromises();
  expect(useSettingsStore().preferencesDraft!.agents['product-lead'].model).toBe('gateway/native-model');
  expect(useSettingsStore().preferencesDraft!.agents.architect.model).toBe('');
  await wrapper.get('[data-agent="product-lead"] .el-select').trigger('click');
  const defaultOption = Array.from(document.querySelectorAll<HTMLElement>('.agent-model-options-product-lead .el-select-dropdown__item')).find((item) =>
    item.textContent?.includes('CLI 默认'),
  );
  expect(defaultOption).toBeDefined();
  await new DOMWrapper(defaultOption!).trigger('click');
  await wrapper.get('#saveSettings').trigger('click');
  await flushPromises();
  await useSettingsStore().load();
  expect(useSettingsStore().preferencesDraft!.agents['product-lead'].model).toBe('');
  wrapper.unmount();
});

test('filtering roles preserves unsaved edits and clears an empty search', async () => {
  const wrapper = await mountView('agents');
  await wrapper.get('#agentSearch').setValue('QA');
  expect(wrapper.findAll('.agent-settings-card').map((row) => row.attributes('data-agent'))).toEqual(['qa']);
  await chooseModel(wrapper, 'qa', 'review-model');
  await wrapper.get('#agentSearch').setValue('review-model');
  await chooseModel(wrapper, 'qa', 'review-model-new');
  expect(wrapper.find('[data-agent="qa"]').exists()).toBe(true);
  await wrapper.get('#agentSearch').setValue('no-such-role');
  expect(wrapper.find('.agents-empty').exists()).toBe(true);
  await wrapper.get('.agents-empty button').trigger('click');
  expect(wrapper.findAll('.agent-settings-card')).toHaveLength(7);
  expect(wrapper.get('[data-agent="qa"] .el-select__placeholder').text()).toBe('review-model-new');
  await wrapper.get('#discardSettings').trigger('click');
  expect(useSettingsStore().preferencesDraft!.agents.qa.model).toBe('');
  wrapper.unmount();
});

test('restoring one role keeps another role pending', async () => {
  const wrapper = await mountView('agents');
  await wrapper.get('#agent-product-lead-cli').setValue('pi');
  await chooseModel(wrapper, 'product-lead', 'planning-model');
  await wrapper.get('#agent-qa-thinking').setValue('high');
  await wrapper.get('[data-agent="product-lead"] .agent-details-button').trigger('click');
  await wrapper.get('[data-agent="product-lead"] .agent-details button').trigger('click');
  expect((wrapper.get('#agent-product-lead-cli').element as HTMLSelectElement).value).toBe('claude');
  expect(useSettingsStore().preferencesDraft!.agents['product-lead'].model).toBe('');
  expect((wrapper.get('#agent-qa-thinking').element as HTMLSelectElement).value).toBe('high');
  expect(wrapper.get('[data-agent="product-lead"]').classes()).not.toContain('modified');
  expect(wrapper.get('[data-agent="qa"]').classes()).toContain('modified');
  expect(isShown(wrapper.get('#settingsSavebar'))).toBe(true);
  wrapper.unmount();
});

test('an invalid hidden role becomes visible and focuses its model field', async () => {
  const wrapper = await mountView('agents');
  await chooseModel(wrapper, 'product-lead', '--bad');
  await wrapper.get('#agentSearch').setValue('Tutor');
  api.preferences.set.mockReturnValueOnce(fail('invalid_choice', 'Invalid model identifier', 'agents.product-lead.model'));
  await wrapper.get('#saveSettings').trigger('click');
  await flushPromises();
  expect(wrapper.findAll('.agent-settings-card')).toHaveLength(7);
  expect(wrapper.get('#agent-product-lead-model').attributes('aria-invalid')).toBe('true');
  expect(document.activeElement?.id).toBe('agent-product-lead-model');
  await chooseModel(wrapper, 'product-lead', 'planning-model');
  expect(wrapper.find('[data-agent="product-lead"] .agent-row-message.error').exists()).toBe(false);
  expect(wrapper.get('#agent-product-lead-model').attributes('aria-invalid')).toBe('false');
  wrapper.unmount();
});

test('the save bar appears with an edit and names the dirty store', async () => {
  const wrapper = await mountView();
  expect(isShown(wrapper.get('#settingsSavebar'))).toBe(false);
  await wrapper.get('#profileName').setValue('Grace');
  expect(isShown(wrapper.get('#settingsSavebar'))).toBe(true);
  expect(wrapper.get('#savebarText').text()).toBe('个人与偏好有未保存的修改');
  // Check only applies to workspace edits.
  expect(isShown(wrapper.get('#checkSettings'))).toBe(false);
  expect(wrapper.get('[data-page="profile"].settings-nav-item').classes()).toContain('dirty');
  expect(wrapper.get('[data-page="preferences"].settings-nav-item').classes()).not.toContain('dirty');
  await wrapper.get('#discardSettings').trigger('click');
  expect(isShown(wrapper.get('#settingsSavebar'))).toBe(false);
  expect((wrapper.get('#profileName').element as HTMLInputElement).value).toBe('Ada');
  wrapper.unmount();
});

test('search hides unmatched pages, their group labels, and shows the empty hint', async () => {
  const wrapper = await mountView();
  await wrapper.get('#settingsSearch').setValue('头像');
  const shownPages = wrapper
    .findAll('.settings-nav-item')
    .filter(isShown)
    .map((item) => item.attributes('data-page'));
  expect(shownPages).toEqual(['profile']);
  const shownGroups = wrapper
    .findAll('.settings-group-label')
    .filter(isShown)
    .map((label) => label.attributes('data-group'));
  expect(shownGroups).toEqual(['personal']);
  expect(isShown(wrapper.get('#settingsSearchEmpty'))).toBe(false);
  await wrapper.get('#settingsSearch').setValue('zzzz');
  expect(wrapper.findAll('.settings-group-label').filter(isShown)).toHaveLength(0);
  expect(isShown(wrapper.get('#settingsSearchEmpty'))).toBe(true);
  wrapper.unmount();
});

test('a save error lands beside its step and focuses its command input', async () => {
  const wrapper = await mountView('commands');
  await wrapper.get('[data-step="lint"] [data-mode="override"]').trigger('click');
  await flushPromises();
  expect(isShown(wrapper.get('#checkSettings'))).toBe(true);
  api.workspace.check.mockReturnValueOnce(fail('shell_syntax', 'steps.lint.commands[0]: command uses shell syntax "|"', 'steps.lint.commands[0]'));
  await wrapper.get('#saveSettings').trigger('click');
  await flushPromises();
  expect(wrapper.get('#step-lint-status').classes()).toContain('error');
  expect(wrapper.get('#step-lint-status').text()).toContain('shell syntax');
  expect(document.activeElement?.id).toBe('step-lint-command');
  expect(api.workspace.set).not.toHaveBeenCalled();
  wrapper.unmount();
});

test('the steps page lists every fixed step and offers to create taskpilot.toml', async () => {
  const wrapper = await mountView('commands');
  expect(wrapper.findAll('[data-step]').map((node) => node.attributes('data-step'))).toEqual([
    'setup',
    'build',
    'format',
    'lint',
    'typecheck',
    'test',
    'coverage',
  ]);
  expect(wrapper.get('[data-step="lint"]').text()).toContain('未配置，跳过');
  expect(wrapper.get('#projectFile').text()).toContain('推荐「TypeScript / JavaScript」预设');
  vi.mocked(feedback.confirmAction).mockResolvedValueOnce(true);
  await wrapper.get('#createProject').trigger('click');
  await flushPromises();
  expect(api.workspace.createProject).toHaveBeenCalledWith('typescript');
  expect(wrapper.get('#projectFile').text()).toMatch(/预设：\s*TypeScript \/ JavaScript/);
  wrapper.unmount();
});

test('a lint override offers the preset command as an option', async () => {
  const wrapper = await mountView('commands');
  await wrapper.get('[data-step="lint"] [data-mode="override"]').trigger('click');
  await flushPromises();
  expect(useSettingsStore().workspaceDraft?.steps.lint).toMatchObject({ mode: 'override', lines: ['npm run lint'] });
  expect(useSettingsStore().dirtyPages.commands).toBe(true);
  wrapper.unmount();
});

test('enter in a form saves instead of reloading', async () => {
  const wrapper = await mountView();
  await wrapper.get('#profileName').setValue('Grace');
  await wrapper.get('#profileForm').trigger('submit');
  await flushPromises();
  expect(api.preferences.set).toHaveBeenCalledWith(expect.objectContaining({ profile: { displayName: 'Grace', avatarColor: 'ocean' } }));
  wrapper.unmount();
});

test('avatar swatches are a radiogroup that arrow keys move through', async () => {
  const wrapper = await mountView();
  expect(wrapper.get('[data-color="ocean"]').attributes('aria-checked')).toBe('true');
  await wrapper.get('#avatarSwatches').trigger('keydown', { key: 'ArrowRight' });
  await flushPromises();
  expect(wrapper.get('[data-color="violet"]').attributes('aria-checked')).toBe('true');
  expect(wrapper.get('#profileAvatarPreview').classes()).toContain('violet');
  expect(document.activeElement?.getAttribute('data-color')).toBe('violet');
  wrapper.unmount();
});

test('the reset button asks for confirmation before resetting', async () => {
  const wrapper = await mountView();
  await wrapper.get('[data-page="data"].settings-nav-item').trigger('click');
  await flushPromises();
  vi.mocked(feedback.confirmAction).mockResolvedValueOnce(false);
  await wrapper.get('#resetProgress').trigger('click');
  await flushPromises();
  expect(feedback.confirmAction).toHaveBeenCalled();
  expect(api.data.resetProgress).not.toHaveBeenCalled();
  wrapper.unmount();
});

test('setup steps run only on click, sending just the step id', async () => {
  api.env.get.mockReturnValue(ok(envState()));
  const wrapper = await mountView('setup');
  expect(wrapper.find('#setupBody').exists()).toBe(true);
  expect(api.env.runStep).not.toHaveBeenCalled();
  await wrapper.get('button[data-step="test"]').trigger('click');
  await flushPromises();
  expect(api.env.runStep).toHaveBeenCalledTimes(1);
  expect(api.env.runStep).toHaveBeenCalledWith('test');
  wrapper.unmount();
});
