// @vitest-environment happy-dom
/** @module-tag integration */
import { beforeEach, expect, test, vi } from 'vitest';
import { DOMWrapper, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

import * as feedback from '@/lib/feedback.ts';
import SettingsView from '@/views/SettingsView.vue';
import { useSettingsStore } from '@/stores/settings.ts';
import { mountView } from '../mount_view.ts';
import { envState, fail, installApi, ok } from '../settings_fakes.ts';

vi.mock('@/lib/feedback.ts', () => ({ showToast: vi.fn(), confirmAction: vi.fn(), confirmChoice: vi.fn(), openDialogs: { value: 0 } }));

let api: ReturnType<typeof installApi>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  api = installApi();
});

const openView = async (page: 'profile' | 'commands' | 'setup' | 'agents' = 'profile') => {
  const pinia = createPinia();
  setActivePinia(pinia);
  const wrapper = await mountView(SettingsView);
  await useSettingsStore().open(page);
  await flushPromises();
  return wrapper;
};

const chooseModel = async (wrapper: Awaited<ReturnType<typeof openView>>, agent: string, value: string) => {
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
  const wrapper = await openView('agents');
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

test('restoring one role keeps another role pending', async () => {
  const wrapper = await openView('agents');
  await wrapper.get('#agent-product-lead-cli').setValue('pi');
  await chooseModel(wrapper, 'product-lead', 'planning-model');
  await wrapper.get('#agent-qa-thinking').setValue('high');
  await wrapper.get('[data-agent="product-lead"] .agent-details-button').trigger('click');
  await wrapper.get('[data-agent="product-lead"] .agent-details button').trigger('click');
  expect((wrapper.get('#agent-product-lead-cli').element as HTMLSelectElement).value).toBe('claude');
  expect(useSettingsStore().preferencesDraft!.agents['product-lead'].model).toBe('');
  expect((wrapper.get('#agent-qa-thinking').element as HTMLSelectElement).value).toBe('high');
  expect(isShown(wrapper.get('#settingsSavebar'))).toBe(true);
});

test('an invalid hidden role becomes visible and focuses its model field', async () => {
  const wrapper = await openView('agents');
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
  const wrapper = await openView();
  expect(isShown(wrapper.get('#settingsSavebar'))).toBe(false);
  await wrapper.get('#profileName').setValue('Grace');
  expect(isShown(wrapper.get('#settingsSavebar'))).toBe(true);
  expect(wrapper.get('#savebarText').text()).toBe('个人与偏好有未保存的修改');
  // Check only applies to workspace edits.
  expect(isShown(wrapper.get('#checkSettings'))).toBe(false);
  await wrapper.get('#discardSettings').trigger('click');
  expect(isShown(wrapper.get('#settingsSavebar'))).toBe(false);
  expect((wrapper.get('#profileName').element as HTMLInputElement).value).toBe('Ada');
  wrapper.unmount();
});

test('a save error lands beside its step and focuses its command input', async () => {
  const wrapper = await openView('commands');
  await wrapper.get('[data-step="lint"] [data-edit]').trigger('click');
  await wrapper.get('[data-step="lint"] [data-mode="override"]').trigger('click');
  await flushPromises();
  expect(isShown(wrapper.get('#checkSettings'))).toBe(true);
  api.workspace.check.mockReturnValueOnce(fail('shell_syntax', 'steps.lint.commands[0]: command uses shell syntax "|"', 'steps.lint.commands[0]'));
  await wrapper.get('#saveSettings').trigger('click');
  await flushPromises();
  expect(wrapper.get('#step-lint-status').text()).toContain('shell syntax');
  expect(document.activeElement?.id).toBe('step-lint-command');
  expect(api.workspace.set).not.toHaveBeenCalled();
  wrapper.unmount();
});

test('the steps page lists every fixed step and offers to create taskpilot.toml', async () => {
  const wrapper = await openView('commands');
  // Grouped by what happens: the submit step first, then what is not set up.
  expect(wrapper.findAll('[data-step-group]').map((node) => node.attributes('data-step-group'))).toEqual(['submit', 'skipped']);
  expect(wrapper.findAll('[data-step]').map((node) => node.attributes('data-step'))).toEqual([
    'test',
    'setup',
    'build',
    'format',
    'lint',
    'typecheck',
    'coverage',
  ]);
  expect(wrapper.get('[data-step="lint"]').text()).toContain('未配置，会跳过');
  // Rows start folded and open on click.
  expect(wrapper.find('[data-step="lint"] [data-mode]').exists()).toBe(false);
  await wrapper.get('[data-step="lint"] [data-edit]').trigger('click');
  expect(wrapper.get('[data-step="lint"] [data-edit]').attributes('aria-expanded')).toBe('true');
  expect(wrapper.get('#projectFile').text()).toContain('推荐「TypeScript / JavaScript」预设');
  expect(wrapper.get('#createProject').text()).toContain('用推荐预设创建');
  vi.mocked(feedback.confirmAction).mockResolvedValueOnce(true);
  await wrapper.get('#createProject').trigger('click');
  await flushPromises();
  expect(api.workspace.createProject).toHaveBeenCalledWith('typescript');
  expect(wrapper.get('#projectFile').text()).toMatch(/预设：\s*TypeScript \/ JavaScript/);
  wrapper.unmount();
});

test('enter in a form saves instead of reloading', async () => {
  const wrapper = await openView();
  await wrapper.get('#profileName').setValue('Grace');
  await wrapper.get('#profileForm').trigger('submit');
  await flushPromises();
  expect(api.preferences.set).toHaveBeenCalledWith(expect.objectContaining({ profile: { displayName: 'Grace', avatarColor: 'ocean' } }));
  wrapper.unmount();
});

test('avatar swatches are a radiogroup that arrow keys move through', async () => {
  const wrapper = await openView();
  expect(wrapper.get('[data-color="ocean"]').attributes('aria-checked')).toBe('true');
  await wrapper.get('#avatarSwatches').trigger('keydown', { key: 'ArrowRight' });
  await flushPromises();
  expect(wrapper.get('[data-color="violet"]').attributes('aria-checked')).toBe('true');
  expect(document.activeElement?.getAttribute('data-color')).toBe('violet');
  wrapper.unmount();
});

test('the reset button asks for confirmation before resetting', async () => {
  const wrapper = await openView();
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
  const wrapper = await openView('setup');
  expect(wrapper.find('#setupBody').exists()).toBe(true);
  expect(api.env.runStep).not.toHaveBeenCalled();
  await wrapper.get('button[data-step="test"]').trigger('click');
  await flushPromises();
  expect(api.env.runStep).toHaveBeenCalledTimes(1);
  expect(api.env.runStep).toHaveBeenCalledWith('test');
  wrapper.unmount();
});
