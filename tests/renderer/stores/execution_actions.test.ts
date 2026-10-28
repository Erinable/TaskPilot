// @vitest-environment happy-dom
// Package actions over their injected execution edges: confirmations guard
// the risky transitions, a claim asks about busy and dirty work first, and
// only one transition runs at a time.
import { beforeEach, expect, test, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { ref } from 'vue';
import type { Ref } from 'vue';

import * as feedback from '@/lib/feedback.ts';
import { createExecutionActions } from '@/stores/execution_actions.ts';
import { useTasksStore } from '@/stores/tasks.ts';
import { installApi, taskView } from '../execution_fakes.ts';
import { fail, ok } from '../ipc_fakes.ts';
import { expectConsole } from '../../fixtures/expected_console.ts';
import type { IpcResult } from '@shared/ipc/envelope.ts';
import type * as packageTypes from '@shared/ipc/packages.ts';

vi.mock('@/lib/feedback.ts', () => ({ showToast: vi.fn(), announceAgent: vi.fn(), confirmAction: vi.fn(async () => true), openDialogs: { value: 0 } }));

let api: ReturnType<typeof installApi>;
let current: Ref<packageTypes.TaskView | null>;
const reloadCurrent = vi.fn(async () => {});
const actionsFor = (task: packageTypes.TaskView) => {
  current = ref<packageTypes.TaskView | null>(task);
  return createExecutionActions({ current, reloadCurrent, open: vi.fn(async () => {}), adoptTask: vi.fn(() => true) });
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(feedback.confirmAction).mockResolvedValue(true);
  setActivePinia(createPinia());
  api = installApi({ task: taskView() });
});

test('rejecting an acceptance asks first; declining sends nothing', async () => {
  vi.mocked(feedback.confirmAction).mockResolvedValueOnce(false);
  const actions = actionsFor(taskView({ status: 'accepting' }));
  await actions.runTransition('acceptance_rejected');
  expect(api.packages.transition).not.toHaveBeenCalled();
  await actions.runTransition('acceptance_rejected');
  expect(api.packages.transition).toHaveBeenCalledWith('t1', 'acceptance_rejected');
  expect(feedback.showToast).toHaveBeenCalledWith('已打回，工作包回到执行中。');
});

test('a second transition while one runs is ignored', async () => {
  const held = Promise.withResolvers<IpcResult<packageTypes.WorkPackageState>>();
  api.packages.transition.mockReturnValueOnce(held.promise);
  const actions = actionsFor(taskView({ status: 'in_progress' }));
  const first = actions.runTransition('block');
  expect(actions.transitioning.value).toBe('block');
  await actions.runTransition('release');
  held.resolve({ ok: true, data: {} as packageTypes.WorkPackageState });
  await first;
  expect(api.packages.transition).toHaveBeenCalledTimes(1);
  expect(actions.transitioning.value).toBeNull();
});

test('claiming asks about other packages in progress and a dirty tree, then opens the mode picker', async () => {
  useTasksStore().tasks = [taskView({ id: 'other', title: '另一个包', status: 'in_progress' })];
  api.workspace.info.mockReturnValue(ok({ configured: true, root: '/r', commit: 'a', branch: 'main', dirty: true, changedFiles: 2 }));
  const actions = actionsFor(taskView({ status: 'pending' }));
  await actions.runTransition('claim');
  expect(vi.mocked(feedback.confirmAction).mock.calls.map(([options]) => options.title)).toEqual(['已经有 1 个工作包在执行中', '项目里还有没提交的改动']);
  expect(actions.claimOpen.value).toBe(true);
  expect(api.packages.transition).not.toHaveBeenCalled();

  actions.claimMode.value = 'practice';
  await actions.confirmClaim();
  expect(api.packages.transition).toHaveBeenCalledWith('t1', 'claim', { mode: 'practice' });
});

test('declining the busy warning stops the claim before the tree is read', async () => {
  useTasksStore().tasks = [taskView({ id: 'other', status: 'in_progress' })];
  vi.mocked(feedback.confirmAction).mockResolvedValueOnce(false);
  const actions = actionsFor(taskView({ status: 'pending' }));
  await actions.runTransition('claim');
  expect(api.workspace.info).not.toHaveBeenCalled();
  expect(actions.claimOpen.value).toBe(false);
});

test('submitting applied Coding Agent changes asks first', async () => {
  vi.mocked(feedback.confirmAction).mockResolvedValueOnce(false);
  const actions = actionsFor(taskView({ status: 'in_progress', codingRun: { status: 'applied' } as packageTypes.TaskView['codingRun'] }));
  await actions.runTransition('submit_for_review');
  expect(feedback.confirmAction).toHaveBeenCalledWith(expect.objectContaining({ title: '确认提交审查？' }));
  expect(api.packages.transition).not.toHaveBeenCalled();
});

test('a deviation needs a note, and its form opens instead of a transition', async () => {
  const actions = actionsFor(taskView({ status: 'in_progress' }));
  await actions.runTransition('report_deviation');
  expect(actions.deviationOpen.value).toBe(true);
  expect(await actions.submitDeviation()).toBe(false);
  expect(feedback.showToast).toHaveBeenCalledWith('请填写偏差说明。');

  actions.deviationForm.value = { note: '接口签名不对', stepIndex: 1, filePath: 'src/a.ts' };
  expect(await actions.submitDeviation()).toBe(true);
  expect(api.packages.transition).toHaveBeenCalledWith('t1', 'report_deviation', { deviation: { note: '接口签名不对', stepIndex: 1, filePath: 'src/a.ts' } });
  expect(actions.deviationOpen.value).toBe(false);
});

test('waiving a dependency updates the queue copy and the open package', async () => {
  const task = taskView({ dependencies: [{ id: 'dep', title: '前置', status: 'in_progress', blocking: true, waived: false }] });
  api = installApi({ task });
  useTasksStore().tasks = [task];
  const actions = actionsFor(task);
  expect(await actions.waiveDependency(task, task.dependencies[0])).toBe(true);
  expect(useTasksStore().tasks[0].dependencies[0]).toMatchObject({ waived: true, blocking: false });
  expect(current.value?.dependencies[0].waived).toBe(true);
});

test('a failed review action toasts and does not reload', async () => {
  api.review.retry.mockReturnValueOnce(fail('invalid_state', 'not failed'));
  const logged = expectConsole('error', /not failed/);
  const actions = actionsFor(taskView({ status: 'in_review' }));
  await actions.runReviewAction('retry');
  expect(logged).toHaveLength(1);
  expect(reloadCurrent).not.toHaveBeenCalled();
  expect(feedback.showToast).toHaveBeenCalledWith(expect.stringMatching(/^操作失败：/));
});
