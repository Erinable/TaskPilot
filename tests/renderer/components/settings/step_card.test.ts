// @vitest-environment happy-dom
import { beforeEach, expect, onTestFinished, test, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';

import StepCard from '@/components/settings/StepCard.vue';
import { useSettingsStore } from '@/stores/settings.ts';
import { installApi } from '../../settings_fakes.ts';
import type { CheckKind } from '@shared/ipc/workspace.ts';

vi.mock('@/lib/feedback.ts', () => ({ showToast: vi.fn(), confirmAction: vi.fn(), openDialogs: { value: 0 } }));

const EXECUTABLE = '/Users/developer/Library/Application Support/node/versions/v24.12.0/bin/npm';

beforeEach(() => {
  setActivePinia(createPinia());
  installApi();
});

const render = async (id: CheckKind = 'test') => {
  const settings = useSettingsStore();
  await settings.load();
  settings.statuses[id] = { tone: 'ok', message: EXECUTABLE };
  const wrapper = mount(StepCard, {
    props: { id },
    attachTo: document.body,
    global: { plugins: [ElementPlus] },
  });
  onTestFinished(() => wrapper.unmount());
  await flushPromises();
  return { settings, wrapper };
};

test('collapsed steps show a compact command-availability label, without repeating the full executable path', async () => {
  const { wrapper } = await render();
  expect(wrapper.get('.step-summary .step-command-found').text()).toBe('命令已找到');
  expect(wrapper.get('.step-command-found').attributes('title')).toContain('不代表此项检查已经运行或通过');
  expect(wrapper.text()).not.toContain(EXECUTABLE);
  expect(wrapper.find('.step-row > .field-status').exists()).toBe(false);
  expect(wrapper.get('.step-command').text()).toBe('npm test');
});

test('expanding a step reveals the full path once with its actual meaning', async () => {
  const { wrapper } = await render();
  await wrapper.get('.step-summary').trigger('click');
  expect(wrapper.get('.step-panel .step-executable code').text()).toBe(EXECUTABLE);
  expect(wrapper.get('.step-executable').text()).toContain('不代表检查已通过');
  expect(wrapper.findAll('#step-test-status')).toHaveLength(1);
  expect(wrapper.get('.step-command').text()).toBe('npm test');
  await wrapper.get('.step-summary').trigger('click');
  expect(wrapper.find('.step-executable').exists()).toBe(false);
  expect(wrapper.text()).not.toContain(EXECUTABLE);
});

test('a missing executable stays visible when folded and is not presented as available', async () => {
  const { settings, wrapper } = await render();
  settings.statuses.test = { tone: 'warn', message: '在当前 PATH 中找不到 npm，请检查运行环境。' };
  await flushPromises();
  expect(wrapper.get('.step-feedback.warn').text()).toContain('找不到 npm');
  expect(wrapper.find('.step-command-found').exists()).toBe(false);
  await wrapper.get('.step-summary').trigger('click');
  expect(wrapper.get('.step-panel .step-field-feedback.warn').text()).toContain('找不到 npm');
  expect(wrapper.findAll('#step-test-status')).toHaveLength(1);
});

test('validation errors still expand the editor and retain the command field status identity', async () => {
  const { settings, wrapper } = await render();
  settings.statuses.test = { tone: 'error', message: '命令不能包含 shell 管道。' };
  await flushPromises();
  expect(wrapper.get('.step-summary').attributes('aria-expanded')).toBe('true');
  expect(wrapper.get('.step-field-feedback.error').text()).toContain('shell 管道');
  expect(wrapper.get('#step-test-status').text()).toContain('shell 管道');
  expect(wrapper.findAll('#step-test-status')).toHaveLength(1);
  expect(wrapper.find('#step-test-command').exists()).toBe(true);
  expect(wrapper.find('.step-command-found').exists()).toBe(false);
});

test('disabling a step removes the obsolete command-availability success message', async () => {
  const { wrapper } = await render();
  await wrapper.get('.step-summary').trigger('click');
  await wrapper.get('[data-mode="off"]').trigger('click');
  expect(wrapper.find('.step-command-found').exists()).toBe(false);
  expect(wrapper.find('.step-executable').exists()).toBe(false);
  expect(wrapper.text()).not.toContain(EXECUTABLE);
});

test('setup wording does not claim manual-only execution and exit-code metadata reads naturally', async () => {
  const { settings, wrapper } = await render('setup');
  const view = settings.workspaceView!.steps.find((step) => step.id === 'setup')!;
  view.effective = {
    lines: ['npm ci --include=dev'],
    cwd: '',
    stage: 'submit',
    blocking: true,
    parser: { format: 'exitcode' },
    timeoutSeconds: null,
  };
  view.source = 'project';
  view.skipped = null;
  await flushPromises();
  expect(wrapper.get('.step-name small').text()).not.toContain('只在你点击时运行');
  expect(wrapper.get('.status-pill').text()).toBe('提交前自动运行');
  await wrapper.get('.step-summary').trigger('click');
  expect(wrapper.get('.step-effective small').text()).toBe('失败会拒绝审查 · 按退出码判断结果');
});
