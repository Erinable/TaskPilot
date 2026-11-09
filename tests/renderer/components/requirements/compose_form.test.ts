// @vitest-environment happy-dom
import { beforeEach, expect, test } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises } from '@vue/test-utils';

import ComposeForm from '@/components/requirements/ComposeForm.vue';
import { useRequirementsStore } from '@/stores/requirements.ts';
import { mountView } from '../../mount_view.ts';
import { installApi } from '../../requirements_fakes.ts';

let api: ReturnType<typeof installApi>;

beforeEach(() => {
  setActivePinia(createPinia());
  api = installApi({ list: [] });
});

test('course starts with its learning content and keeps labeled configuration, toolchain gating and cost information', async () => {
  const store = useRequirementsStore();
  store.startCompose('course');
  const wrapper = await mountView(ComposeForm);
  const rows = wrapper.findAll('.setting-row');
  expect(rows[0].get('label').attributes('for')).toBe('reqText');
  expect(rows[0].get('label').text()).toBe('想学的内容');
  expect(document.activeElement).toBe(wrapper.get('#reqText').element);
  expect(wrapper.get('#reqText').attributes('aria-describedby')).toBe('reqTextStatus');
  for (const label of ['基础', '目标', '每周时间', '实验工具链']) expect(wrapper.find(`[role="radiogroup"][aria-label="${label}"]`).exists()).toBe(true);
  expect(wrapper.get('label[for="reqEnvironment"]').text()).toContain('环境备注（可选）');
  expect(wrapper.get('label[for="reqTitle"]').text()).toContain('Tutor');
  expect(wrapper.get('.req-context-list').text()).toContain('花费计入 AI 团队页的本周统计');
  expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeDefined();

  await wrapper.get('#reqText').setValue('我想学进程调度');
  await wrapper.get('#reqText').trigger('keydown', { key: 'Enter', ctrlKey: true });
  await wrapper.get('form').trigger('submit');
  expect(api.requirements.create).not.toHaveBeenCalled();

  await wrapper.get('[data-field="toolchain"] input[value="c"]').setValue(true);
  expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeUndefined();
  await wrapper.get('form').trigger('submit');
  await flushPromises();
  expect(api.requirements.create).toHaveBeenCalledWith({ title: '', text: '我想学进程调度', course: { ...store.composeForm, toolchain: 'c' } });
  store.stopWatching();
});

test('project keeps title before requirement description', async () => {
  const wrapper = await mountView(ComposeForm);
  expect(wrapper.findAll('.setting-row label').map((label) => label.attributes('for'))).toEqual(['reqTitle', 'reqText']);
  expect(wrapper.find('[data-field="toolchain"]').exists()).toBe(false);
});

test.each(['metaKey', 'ctrlKey'] as const)('%s + Enter ignores IME composition and prevents default only for submission', async (modifier) => {
  const store = useRequirementsStore();
  const wrapper = await mountView(ComposeForm);
  const textarea = wrapper.get('#reqText');
  await textarea.setValue('用户可以用邮箱登录');
  const composing = new KeyboardEvent('keydown', { key: 'Enter', [modifier]: true, isComposing: true, bubbles: true, cancelable: true });
  textarea.element.dispatchEvent(composing);
  await flushPromises();
  expect(api.requirements.create).not.toHaveBeenCalled();
  expect(composing.defaultPrevented).toBe(false);

  const plainEnter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  textarea.element.dispatchEvent(plainEnter);
  expect(api.requirements.create).not.toHaveBeenCalled();
  expect(plainEnter.defaultPrevented).toBe(false);

  const submit = new KeyboardEvent('keydown', { key: 'Enter', [modifier]: true, bubbles: true, cancelable: true });
  textarea.element.dispatchEvent(submit);
  await flushPromises();
  expect(submit.defaultPrevented).toBe(true);
  expect(api.requirements.create).toHaveBeenCalledExactlyOnceWith({ title: '', text: '用户可以用邮箱登录' });
  store.stopWatching();
});

test('keyboard shortcut respects the submitting state', async () => {
  const store = useRequirementsStore();
  store.submitting = true;
  const wrapper = await mountView(ComposeForm);
  await wrapper.get('#reqText').setValue('邮箱登录');
  await wrapper.get('#reqText').trigger('keydown', { key: 'Enter', metaKey: true });
  expect(api.requirements.create).not.toHaveBeenCalled();
});
