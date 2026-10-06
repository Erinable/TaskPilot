// @vitest-environment happy-dom
import { beforeEach, expect, test, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
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

const mountView = async (page: 'profile' | 'commands' | 'setup' = 'profile') => {
  const pinia = createPinia();
  setActivePinia(pinia);
  const wrapper = mount(SettingsView, { global: { plugins: [ElementPlus, pinia] }, attachTo: document.body });
  await useSettingsStore().open(page);
  await flushPromises();
  return wrapper;
};

const isShown = (element: { attributes: (name: string) => string | undefined }) => !(element.attributes('style') ?? '').includes('display: none');

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

test('a save error lands beside its input and focuses it', async () => {
  const wrapper = await mountView('commands');
  await wrapper.get('#commandLint').setValue('eslint . | cat');
  expect(isShown(wrapper.get('#checkSettings'))).toBe(true);
  api.workspace.check.mockReturnValueOnce(fail('shell_syntax', 'bad', 'lint'));
  await wrapper.get('#saveSettings').trigger('click');
  await flushPromises();
  expect(wrapper.get('#statusLint').classes()).toContain('error');
  expect(wrapper.get('#statusLint').text()).toBe('不支持 shell 语法，请改用 package.json 脚本。');
  expect(wrapper.get('#commandLint').attributes('aria-invalid')).toBe('true');
  expect(document.activeElement?.id).toBe('commandLint');
  expect(api.workspace.set).not.toHaveBeenCalled();
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
