// @vitest-environment happy-dom
import { beforeEach, expect, test, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';

import AcceptanceReview from '../../../../src/renderer/src/components/execution/AcceptanceReview.vue';
import { useExecutionStore } from '../../../../src/renderer/src/stores/execution.ts';
import { installApi, passedReview, taskView } from '../../execution_fakes.ts';

vi.mock('../../../../src/renderer/src/lib/feedback.ts', () => ({
  showToast: vi.fn(),
  confirmAction: vi.fn(async () => true),
  announceAgent: vi.fn(),
  openDialogs: { value: 0 },
}));

beforeEach(() => {
  setActivePinia(createPinia());
});
const render = () => {
  const review = passedReview();
  const current = {
    task: taskView({ status: 'accepting', review, acceptance: [{ text: '断网时仍能阅读' }], humanTransitions: ['accepted', 'acceptance_rejected'] }),
  };
  const api = installApi(current);
  useExecutionStore().current = current.task;
  const wrapper = mount(AcceptanceReview, { props: { task: current.task, review } });
  return { wrapper, api, current, review };
};

test('a green QA judgment never preconfirms manual acceptance; the checkbox enables one explicit decision', async () => {
  const { wrapper, api } = render();
  const accept = wrapper.get('[data-transition="accepted"]');
  expect(wrapper.get('.decision-progress').text()).toBe('已确认 0 / 1 项');
  expect(wrapper.get('.decision-evidence').text()).toContain('QA 判断满足');
  expect(wrapper.get('.decision-evidence').text()).toContain('无关联测试');
  expect(accept.attributes('disabled')).toBeDefined();
  await accept.trigger('click');
  expect(api.packages.transition).not.toHaveBeenCalled();
  await wrapper.get('[data-confirm-criterion="0"]').setValue(true);
  expect(accept.attributes('disabled')).toBeUndefined();
  expect(api.packages.transition).not.toHaveBeenCalled();
  await accept.trigger('click');
  await flushPromises();
  expect(api.packages.transition).toHaveBeenCalledWith('t1', 'accepted');
  wrapper.unmount();
});

test('rejection is available before confirmation and returns through the existing state transition', async () => {
  const { wrapper, api } = render();
  const reject = wrapper.get('[data-transition="acceptance_rejected"]');
  expect(reject.attributes('disabled')).toBeUndefined();
  await reject.trigger('click');
  await flushPromises();
  expect(api.packages.transition).toHaveBeenCalledWith('t1', 'acceptance_rejected');
  wrapper.unmount();
});

test('identical refresh keeps this confirmation, a changed review or package clears it', async () => {
  const { wrapper, review, current } = render();
  await wrapper.get('[data-confirm-criterion="0"]').setValue(true);
  await wrapper.setProps({ review: structuredClone(review) });
  expect(wrapper.get('[data-transition="accepted"]').attributes('disabled')).toBeUndefined();
  const nextReview = { ...review, finishedAt: '2026-11-11T11:00:00Z' };
  await wrapper.setProps({ review: nextReview });
  expect(wrapper.get('[data-transition="accepted"]').attributes('disabled')).toBeDefined();
  await wrapper.get('[data-confirm-criterion="0"]').setValue(true);
  await wrapper.setProps({ task: { ...current.task, id: 'other' } });
  expect(wrapper.get('[data-transition="accepted"]').attributes('disabled')).toBeDefined();
  wrapper.unmount();
});

test('an already-passing linked test and general unverifiable check both require fresh human confirmation', async () => {
  const { wrapper, review, current } = render();
  await wrapper.setProps({
    review: {
      ...review,
      acceptance: [{ text: '断网时仍能阅读', test: 'offline works', status: 'verified', verified: true, manual: false, alreadyPassing: true }],
      attention: [
        { code: 'criterion_already_passing', index: 0 },
        { code: 'check_unverifiable', kind: 'test', reason: 'report_missing', blocking: true },
      ],
    },
    task: { ...current.task, acceptance: [{ text: '断网时仍能阅读', test: 'offline works' }] },
  });
  expect(wrapper.get('.decision-progress').text()).toBe('已确认 0 / 2 项');
  await wrapper.get('[data-confirm-criterion="0"]').setValue(true);
  expect(wrapper.get('[data-transition="accepted"]').attributes('disabled')).toBeDefined();
  await wrapper.get('[data-confirm-attention]').setValue(true);
  expect(wrapper.get('[data-transition="accepted"]').attributes('disabled')).toBeUndefined();
  wrapper.unmount();
});

test('a failed manual recheck replaces passed evidence and requires fresh confirmation', async () => {
  const { wrapper, review, current, api } = render();
  const acceptance = [{ text: '断网时仍能阅读', test: 'offline works', status: 'verified' as const, verified: true, manual: false, alreadyPassing: true }];
  await wrapper.setProps({
    task: { ...current.task, acceptance: [{ text: '断网时仍能阅读', test: 'offline works' }] },
    review: { ...review, acceptance, attention: [{ code: 'criterion_already_passing', index: 0 }] },
  });
  const execution = useExecutionStore();
  api.verify.run.mockResolvedValueOnce({
    ok: true,
    data: {
      kind: 'test',
      command: 'npm test',
      exitCode: 1,
      timedOut: false,
      durationMs: 1,
      output: 'not ok - offline works',
      results: [{ name: 'offline works', passed: false, skipped: false, todo: false }],
      diagnostics: [],
      summary: { total: 1, passed: 0, failed: 1, skipped: 0, ok: false },
      report: { format: 'stdout', trusted: true, problem: null },
      check: { stage: 'submit', blocking: true },
      acceptance: [{ ...acceptance[0], status: 'failed', verified: false, alreadyPassing: false }],
    },
  });
  await wrapper.get('[data-confirm-criterion="0"]').setValue(true);
  expect(wrapper.get('[data-transition="accepted"]').attributes('disabled')).toBeUndefined();
  await execution.runVerification('test');
  await flushPromises();
  expect(wrapper.get('.decision-evidence').text()).toContain('关联测试失败');
  expect(wrapper.get('.decision-evidence').text()).toContain('待你确认');
  expect(wrapper.get('.decision-evidence').text()).not.toContain('你已确认');
  expect(wrapper.get('[data-transition="accepted"]').attributes('disabled')).toBeDefined();
  await wrapper.get('[data-transition="accepted"]').trigger('click');
  expect(api.packages.transition).not.toHaveBeenCalled();
  wrapper.unmount();
});

test('identical effective recheck evidence preserves confirmation but removing it requires fresh judgment', async () => {
  const { wrapper } = render();
  const execution = useExecutionStore();
  const acceptance = [{ text: '断网时仍能阅读', status: 'manual' as const, verified: false, manual: true }];
  execution.acceptanceOverride = acceptance;
  await flushPromises();
  await wrapper.get('[data-confirm-criterion="0"]').setValue(true);
  execution.acceptanceOverride = structuredClone(acceptance);
  await flushPromises();
  expect(wrapper.get('[data-transition="accepted"]').attributes('disabled')).toBeUndefined();
  execution.acceptanceOverride = [{ text: '断网时仍能阅读', status: 'unverifiable', verified: false, manual: false }];
  await flushPromises();
  expect(wrapper.get('[data-transition="accepted"]').attributes('disabled')).toBeDefined();
  await wrapper.get('[data-confirm-criterion="0"]').setValue(true);
  execution.acceptanceOverride = null;
  await flushPromises();
  expect(wrapper.get('[data-transition="accepted"]').attributes('disabled')).toBeDefined();
  wrapper.unmount();
});

test('linked tests alone can provide a verified criterion without inventing a manual checkbox', async () => {
  const { wrapper, review, current } = render();
  await wrapper.setProps({
    review: { ...review, attention: [], acceptance: [{ text: '断网时仍能阅读', test: 'offline works', status: 'verified', verified: true, manual: false }] },
    task: { ...current.task, acceptance: [{ text: '断网时仍能阅读', test: 'offline works' }] },
  });
  expect(wrapper.find('[data-confirm-criterion]').exists()).toBe(false);
  expect(wrapper.text()).toContain('关联测试已通过');
  expect(wrapper.get('[data-transition="accepted"]').attributes('disabled')).toBeUndefined();
  wrapper.unmount();
});
