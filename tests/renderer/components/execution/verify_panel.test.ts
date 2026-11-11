// @vitest-environment happy-dom
import { beforeEach, expect, test } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { defineComponent, h } from 'vue';
import { flushPromises } from '@vue/test-utils';

import VerifyPanel from '../../../../src/renderer/src/components/execution/VerifyPanel.vue';
import { useExecutionStore } from '../../../../src/renderer/src/stores/execution.ts';
import type * as packageTypes from '../../../../src/shared/ipc/packages.ts';
import type * as workspaceTypes from '../../../../src/shared/ipc/workspace.ts';
import { codingRun, installApi, taskView } from '../../execution_fakes.ts';
import { mountView } from '../../mount_view.ts';

const AT = '2026-09-30T17:05:09Z';
const run = (kind: workspaceTypes.CheckKind = 'test', overrides: Partial<workspaceTypes.CheckRun> = {}): workspaceTypes.CheckRun => ({
  kind,
  command: `npm run ${kind}`,
  exitCode: 0,
  timedOut: false,
  durationMs: 100,
  output: '',
  results: [],
  diagnostics: [],
  summary: { total: 1, passed: 1, failed: 0, skipped: 0, ok: true },
  report: { format: 'tests', trusted: true, problem: null },
  check: { stage: 'submit', blocking: true },
  ...overrides,
});
const check = (kind: workspaceTypes.CheckKind = 'test', overrides: Partial<packageTypes.ReviewCheck> = {}): packageTypes.ReviewCheck => ({
  kind,
  stage: 'submit',
  blocking: true,
  baseline: 'measured',
  status: 'pass',
  reason: null,
  newFailures: [],
  preexisting: [],
  fixed: [],
  run: { ...run(kind), failing: [], outputTail: null },
  ...overrides,
});
const review = (checks: packageTypes.ReviewCheck[] = []): Extract<packageTypes.Review, { status: 'passed' | 'rejected' }> => ({
  status: 'passed',
  error: null,
  startedAt: '2026-09-30T17:00:00Z',
  finishedAt: AT,
  reasons: [],
  attention: [],
  checks,
  verification: null,
  acceptance: [],
  report: null,
  diff: { files: [], skipped: [], outOfScope: [] },
  costUsd: 0,
});

beforeEach(() => {
  setActivePinia(createPinia());
});

const render = async (task: packageTypes.TaskView) => {
  const api = installApi({ task });
  const execution = useExecutionStore();
  execution.current = task;
  execution.verifySteps = [{ id: 'test', label: null }];
  const wrapper = await mountView(defineComponent({ render: () => h(VerifyPanel, { task: execution.current! }) }));
  return { wrapper, execution, api };
};

test('empty manual checks explain their host and do not run anything on mount', async () => {
  const { wrapper, execution, api } = await render(taskView({ baseline: null }));
  expect(wrapper.get('h2').text()).toBe('手动复查');
  expect(wrapper.get('.panel-heading p').text()).toContain('当前主机的项目工作区');
  expect(wrapper.get('.panel-heading p').text()).toContain('你自己的账号权限');
  expect(wrapper.get('.verify-result').text()).toBe('本次尚未手动复查');
  expect(wrapper.get('[data-check-history]').text()).toBe('暂无自动检查历史');
  expect(execution.verifyResult).toBeNull();
  expect(api.verify.run).not.toHaveBeenCalled();
  expect(api.review.retry).not.toHaveBeenCalled();
});

test('a complete successful review shows all five historical checks with its business timestamp', async () => {
  const kinds: workspaceTypes.CheckKind[] = ['build', 'format', 'lint', 'typecheck', 'test'];
  const { wrapper, execution, api } = await render(taskView({ review: review(kinds.map((kind) => check(kind))) }));
  const history = wrapper.get('[data-check-history]');
  expect(history.get('.history-summary').text()).toBe('上次提交检查：5/5 项通过');
  expect(history.get('time').text()).toBe('2026-10-01 01:05:09');
  expect(history.get('time').attributes('datetime')).toBe(AT);
  expect(history.findAll('[data-check-status="pass"]')).toHaveLength(5);
  expect(history.text()).toContain('不能证明当前工作树仍然通过');
  expect(wrapper.get('.verify-result').text()).toBe('本次尚未手动复查');
  expect(execution.verifyResult).toBeNull();
  expect(api.verify.run).not.toHaveBeenCalled();
});

test('failed, unverifiable, skipped and missing review runs all stay in the denominator', async () => {
  const failedRun: workspaceTypes.CompactRun = {
    ...run('lint', { exitCode: 1, summary: { total: 1, passed: 0, failed: 1, skipped: 0, ok: false } }),
    failing: ['lint failed'],
    outputTail: null,
  };
  const checks = [
    check(),
    check('lint', { status: 'fail', run: failedRun }),
    check('build', { status: 'unverifiable', run: { error: { code: 'command_missing', message: 'not installed' } } }),
    check('typecheck', { run: null }),
    check('format', { status: 'skipped', run: null }),
    // A preexisting failure may pass the review's baseline comparison, but the command did not pass.
    check('custom:legacy', { status: 'pass', reason: 'preexisting_only', run: failedRun }),
  ];
  const rejected = { ...review(checks), status: 'rejected' as const };
  const { wrapper } = await render(taskView({ review: rejected }));
  const history = wrapper.get('[data-check-history]');
  expect(history.get('.history-summary').text()).toBe('上次提交检查：1/6 项通过');
  expect(history.findAll('[data-check-status]').map((row) => row.attributes('data-check-status'))).toEqual([
    'pass',
    'fail',
    'unverifiable',
    'missing',
    'skipped',
    'fail',
  ]);
  expect(history.text()).toContain('无法验证');
  expect(history.text()).toContain('缺少运行记录');
  expect(history.text()).toContain('未运行');
});

test.each(['running', 'failed'] as const)('a %s current review cannot borrow an old successful coding result', async (status) => {
  const active: packageTypes.Review =
    status === 'running'
      ? { status, startedAt: AT, finishedAt: null, error: null }
      : { status, startedAt: AT, finishedAt: null, error: { code: 'agent_cancelled', message: 'cancelled' } };
  const { wrapper } = await render(taskView({ review: active, codingRun: codingRun({ status: 'submitted', finishedAt: AT, checks: { test: run() } }) }));
  const history = wrapper.get('[data-check-history]');
  expect(history.text()).toContain(status === 'running' ? '进行中' : '审查未完成');
  expect(history.text()).not.toContain('项通过');
  expect(history.find('[data-check-status="pass"]').exists()).toBe(false);
  expect(history.get('time').text()).toBe('2026-10-01 01:05:09');
});

test('a finished review without checks stays empty instead of borrowing coding success', async () => {
  const { wrapper } = await render(taskView({ review: review(), codingRun: codingRun({ status: 'submitted', checks: { test: run() } }) }));
  expect(wrapper.get('[data-check-history]').text()).toContain('上次提交检查：没有记录自动检查');
  expect(wrapper.get('[data-check-history]').text()).not.toContain('项通过');
});

test('coding history is the fallback without a review and uses the coding completion time', async () => {
  const { wrapper } = await render(
    taskView({
      codingRun: codingRun({
        status: 'applied',
        finishedAt: AT,
        checks: {
          test: run(),
          build: run('build', { exitCode: 1, summary: { total: 0, passed: 0, failed: 0, skipped: 0, ok: false } }),
          lint: run('lint', { report: { format: 'junit', trusted: false, problem: 'missing' } }),
        },
      }),
    }),
  );
  const history = wrapper.get('[data-check-history]');
  expect(history.get('.history-summary').text()).toBe('上次编码检查：1/3 项通过');
  expect(history.get('time').text()).toBe('2026-10-01 01:05:09');
  expect(history.findAll('[data-check-status]').map((row) => row.attributes('data-check-status'))).toEqual(['pass', 'fail', 'unverifiable']);
});

test('unfinished coding checks do not present partial success as completed history', async () => {
  const { wrapper } = await render(taskView({ codingRun: codingRun({ status: 'checking', checks: { test: run() } }) }));
  expect(wrapper.get('[data-check-history]').text()).toBe('本轮编码与自动检查尚未完成');
  expect(wrapper.find('[data-check-status="pass"]').exists()).toBe(false);
});

test('manual results remain separate from history and only the selected button runs a check', async () => {
  const { wrapper, execution, api } = await render(taskView({ review: review([check()]) }));
  const manual = run('test', { exitCode: 1, summary: { total: 1, passed: 0, failed: 1, skipped: 0, ok: false } });
  api.verify.run.mockResolvedValue({ ok: true, data: manual });
  await wrapper.get('[data-verify="test"]').trigger('click');
  await flushPromises();
  expect(api.verify.run).toHaveBeenCalledExactlyOnceWith('test', 't1');
  expect(wrapper.get('.verify-result').text()).toContain('本次手动复查结果');
  expect(wrapper.get('.verify-summary').text()).toContain('失败');
  expect(execution.verifyResult).toEqual(manual);
  expect(wrapper.get('.history-summary').text()).toBe('上次提交检查：1/1 项通过');
  execution.current = taskView({ review: review([check('lint', { run: null })]) });
  await flushPromises();
  expect(execution.verifyResult).toEqual(manual);
  expect(wrapper.get('.verify-summary').text()).toContain('失败');
  expect(wrapper.get('.history-summary').text()).toBe('上次提交检查：0/1 项通过');
  expect(api.verify.run).toHaveBeenCalledTimes(1);
});
