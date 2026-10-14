// @vitest-environment happy-dom
import { beforeEach, expect, test, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';

import CodingIsolation from '../../../src/renderer/src/components/settings/CodingIsolation.vue';
import { useSettingsStore } from '../../../src/renderer/src/stores/settings.ts';
import * as feedback from '../../../src/renderer/src/lib/feedback.ts';
import { preferences } from '../settings_fakes.ts';

vi.mock('../../../src/renderer/src/lib/feedback.ts', () => ({ showToast: vi.fn(), confirmAction: vi.fn(async () => true), openDialogs: { value: 0 } }));

let picked: string | null = '/srv/shared';
beforeEach(() => {
  setActivePinia(createPinia());
  const prefs = preferences();
  useSettingsStore().preferencesDraft = { ...prefs, coding: { isolation: 'sandbox', extraRead: [], extraWrite: [] } } as never;
  (window as unknown as { taskpilot: unknown }).taskpilot = { workspace: { pickRoot: vi.fn(async () => ({ ok: true, data: picked })) } };
  vi.mocked(feedback.confirmAction).mockClear();
});

const render = async () => {
  const wrapper = mount(CodingIsolation);
  await flushPromises();
  return wrapper;
};
const draft = () => useSettingsStore().preferencesDraft!.coding;

test('sandbox is selected by default and its default permissions are spelled out, network included', async () => {
  const wrapper = await render();
  expect(wrapper.find('.isolation-mode.active strong').text()).toBe('沙箱（推荐）');
  expect(wrapper.find('.sandbox-defaults').text()).toContain('可以联网');
  expect(wrapper.find('.sandbox-defaults').text()).toContain('~/.ssh');
});

test('folders are added with the picker and removed again', async () => {
  const wrapper = await render();
  await wrapper.findAll('.sandbox-exceptions-head button')[0].trigger('click');
  await flushPromises();
  expect(draft().extraRead).toEqual(['/srv/shared']);
  expect(feedback.confirmAction).not.toHaveBeenCalled();
  await wrapper.find('.sandbox-folders button').trigger('click');
  expect(draft().extraRead).toEqual([]);
});

test('a sensitive folder asks first, and declining adds nothing', async () => {
  picked = '/Users/ada/.ssh';
  vi.mocked(feedback.confirmAction).mockResolvedValueOnce(false);
  const wrapper = await render();
  await wrapper.findAll('.sandbox-exceptions-head button')[1].trigger('click');
  await flushPromises();
  expect(vi.mocked(feedback.confirmAction).mock.calls[0][0].title).toBe('这个文件夹可能存着密钥或个人文件');
  expect(draft().extraWrite).toEqual([]);
  picked = '/srv/shared';
});

test('separate-user mode hides the sandbox exceptions', async () => {
  const wrapper = await render();
  await wrapper.findAll('input[type="radio"]')[1].setValue(true);
  expect(draft().isolation).toBe('separate-user');
  expect(wrapper.find('.sandbox-exceptions').exists()).toBe(false);
});
