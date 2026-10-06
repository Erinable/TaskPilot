// @vitest-environment happy-dom
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import ElementPlus from 'element-plus';

import ExecutionView from '../../../src/renderer/src/views/ExecutionView.vue';
import { ACTIONS, useExecutionStore } from '../../../src/renderer/src/stores/execution.ts';
import type * as ipc from '../../../src/shared/ipc_types.ts';
import { installApi, taskView } from '../execution_fakes.ts';

vi.mock('../../../src/renderer/src/lib/feedback.ts', () => ({ showToast: vi.fn(), confirmAction: vi.fn(async () => true), openDialogs: { value: 0 } }));

let current: { task: ipc.TaskView };
let api: ReturnType<typeof installApi>;

const mountOpen = async () => {
  const pinia = createPinia();
  setActivePinia(pinia);
  const execution = useExecutionStore();
  await execution.open(current.task.id);
  const wrapper = mount(ExecutionView, { global: { plugins: [ElementPlus, pinia] }, attachTo: document.body });
  await flushPromises();
  return { wrapper, execution };
};

beforeEach(() => {
  document.body.replaceChildren();
  current = { task: taskView() };
  api = installApi(current);
});

describe('ExecutionView', () => {
  test('action buttons come from humanTransitions in ACTIONS order', async () => {
    current.task = taskView({ humanTransitions: ['release', 'report_deviation', 'submit_for_review', 'block'] });
    const { wrapper } = await mountOpen();
    const names = wrapper.findAll('[data-transition]').map((button) => button.attributes('data-transition'));
    expect(names).toEqual(['submit_for_review', 'report_deviation', 'block', 'release']);
    expect(names).toEqual(ACTIONS.map((action) => action.name).filter((name) => names.includes(name)));
    expect(wrapper.find('[data-transition="submit_for_review"]').classes()).toContain('primary-button');
    expect(wrapper.find('[data-transition="report_deviation"]').classes()).toEqual(expect.arrayContaining(['secondary-button', 'danger']));
    expect(wrapper.find('.exec-notice').exists()).toBe(false);
    wrapper.unmount();
  });

  test('without human transitions the AI-team notice shows', async () => {
    current.task = taskView({ status: 'in_review', statusLabel: '审查中' });
    const { wrapper } = await mountOpen();
    expect(wrapper.find('.exec-notice').text()).toBe('当前状态「审查中」由 AI 团队推进，你无需操作。');
    wrapper.unmount();
  });

  test('clicking an action runs the transition and reloads', async () => {
    current.task = taskView({ humanTransitions: ['block'] });
    const { wrapper } = await mountOpen();
    api.getTask.mockClear();
    await wrapper.find('[data-transition="block"]').trigger('click');
    await flushPromises();
    expect(api.transition).toHaveBeenCalledWith('t1', 'block');
    expect(api.getTask).toHaveBeenCalled();
    expect(api.listTasks).toHaveBeenCalled();
    wrapper.unmount();
  });

  test('agent-authored text renders as text, with backticks as <code>', async () => {
    const payload = '<img src=x onerror="alert(1)">';
    current.task = taskView({
      title: payload,
      steps: [`运行 \`${payload}\``],
      deviations: [{ note: payload, stepIndex: 0, filePath: 'src/auth.ts', reportedAt: '2026-01-02T00:00:00.000Z', resolution: { decision: 'dismiss', reason: payload, changes: [payload], decidedAt: '', afterContest: false, contested: false, reverted: false } }],
      review: {
        status: 'rejected', error: null, startedAt: '', finishedAt: null, reasons: ['qa_rejected'], attention: [], checks: [], verification: null, acceptance: [],
        report: { verdict: 'reject', summary: payload, criteria: [], issues: [{ severity: 'major', text: payload, file: null, line: null }] },
        diff: { files: [], skipped: [], outOfScope: [] }, costUsd: 0,
      },
    });
    const { wrapper } = await mountOpen();
    expect(document.querySelector('img')).toBeNull();
    expect(wrapper.find('h1').text()).toBe(payload);
    expect(wrapper.find('.step-text code').text()).toBe(payload);
    expect(wrapper.find('.deviation-item p').text()).toBe(payload);
    expect(wrapper.find('.review-summary').text()).toBe(payload);
    expect(wrapper.find('.review-issue p').text()).toBe(payload);
    wrapper.unmount();
  });

  test('the deviation dialog sends the chosen step and file', async () => {
    current.task = taskView({ humanTransitions: ['report_deviation'] });
    const { wrapper, execution } = await mountOpen();
    await wrapper.find('[data-transition="report_deviation"]').trigger('click');
    await flushPromises();
    expect(execution.deviationOpen).toBe(true);
    expect(document.querySelector('#deviationTitle')?.textContent).toBe('报告偏差');
    // The selects are Element Plus; drive the form the way their v-model does.
    execution.deviationForm = { note: '接口不一致', stepIndex: 0, filePath: null };
    await flushPromises();
    const submit = [...document.querySelectorAll('.modal-actions .primary-button')].find((node) => node.textContent?.includes('提交偏差')) as HTMLButtonElement;
    submit.click();
    await flushPromises();
    expect(api.transition).toHaveBeenCalledWith('t1', 'report_deviation', { deviation: { note: '接口不一致', stepIndex: 0, filePath: null } });
    expect(execution.deviationOpen).toBe(false);
    wrapper.unmount();
  });

  test('unmounting the view clears the package', async () => {
    const { wrapper, execution } = await mountOpen();
    wrapper.unmount();
    expect(execution.current).toBeNull();
  });
});
