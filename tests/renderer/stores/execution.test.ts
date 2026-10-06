// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

import { BASELINE_POLL_MS, REVIEW_POLL_MS, useExecutionStore } from '../../../src/renderer/src/stores/execution.ts';
import { useAppStore } from '../../../src/renderer/src/stores/app.ts';
import { useTasksStore } from '../../../src/renderer/src/stores/tasks.ts';
import * as feedback from '../../../src/renderer/src/lib/feedback.ts';
import type * as ipc from '../../../src/shared/ipc_types.ts';
import { installApi, taskView } from '../execution_fakes.ts';

vi.mock('../../../src/renderer/src/lib/feedback.ts', () => ({ showToast: vi.fn(), confirmAction: vi.fn(async () => true), openDialogs: { value: 0 } }));

const running: ipc.Review = { status: 'running', error: null, startedAt: '', finishedAt: null };

let current: { task: ipc.TaskView };
let api: ReturnType<typeof installApi>;

beforeEach(() => {
  setActivePinia(createPinia());
  current = { task: taskView() };
  api = installApi(current);
  vi.mocked(feedback.showToast).mockClear();
  vi.mocked(feedback.confirmAction).mockClear();
});

afterEach(() => vi.useRealTimers());

describe('execution store', () => {
  test('open() loads the package, navigates and reads the diff', async () => {
    const execution = useExecutionStore();
    await execution.open('t1');
    expect(useAppStore().view).toBe('execution');
    expect(execution.current?.id).toBe('t1');
    expect(api.diff.stat).toHaveBeenCalledWith('t1');
    expect(execution.diffHint).toBe('相对基线 abcdef12');
  });

  test('open() reports a failed load and stays put', async () => {
    api.getTask.mockResolvedValueOnce({ ok: false, error: { code: 'x', message: '没有这个工作包' } } as never);
    const execution = useExecutionStore();
    await execution.open('missing');
    expect(useAppStore().view).toBe('queue');
    expect(feedback.showToast).toHaveBeenCalledWith('打开工作包失败：没有这个工作包');
  });

  test('a transition calls IPC, then reloads the package and the queue', async () => {
    const execution = useExecutionStore();
    await execution.open('t1');
    api.getTask.mockClear();
    current.task = taskView({ status: 'in_review', statusLabel: '审查中' });
    await execution.runTransition('submit_for_review');
    expect(api.transition).toHaveBeenCalledWith('t1', 'submit_for_review');
    expect(api.getTask.mock.invocationCallOrder[0]).toBeGreaterThan(api.transition.mock.invocationCallOrder[0]);
    expect(api.listTasks).toHaveBeenCalled();
    expect(useTasksStore().tasks).toHaveLength(1);
    expect(execution.current?.status).toBe('in_review');
    expect(feedback.showToast).toHaveBeenCalledWith('已提交，QA 正在审查。');
  });

  test('a second transition is ignored while one is in flight', async () => {
    const execution = useExecutionStore();
    await execution.open('t1');
    const first = execution.runTransition('submit_for_review');
    expect(execution.transitioning).toBe('submit_for_review');
    await execution.runTransition('submit_for_review');
    await first;
    expect(api.transition).toHaveBeenCalledTimes(1);
    expect(execution.transitioning).toBe(null);
  });

  test('a failed transition clears the in-flight state', async () => {
    const execution = useExecutionStore();
    await execution.open('t1');
    api.transition.mockResolvedValueOnce({ ok: false, error: { code: 'x', message: 'x' } } as never);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await execution.runTransition('submit_for_review');
    spy.mockRestore();
    expect(execution.transitioning).toBe(null);
  });

  test('a saved step also updates the queue copy of the package', async () => {
    const execution = useExecutionStore();
    useTasksStore().tasks = [taskView(), taskView({ id: 't2' })];
    await execution.open('t1');
    expect(await execution.setStepDone(1, true)).toBe(true);
    expect(useTasksStore().tasks.map((task) => task.completedSteps)).toEqual([[1], []]);
  });

  test('confirmed transitions ask first and stop when declined', async () => {
    const execution = useExecutionStore();
    await execution.open('t1');
    vi.mocked(feedback.confirmAction).mockResolvedValueOnce(false);
    await execution.runTransition('acceptance_rejected');
    expect(feedback.confirmAction).toHaveBeenCalledWith(expect.objectContaining({ title: '打回这个工作包？', danger: true }));
    expect(api.transition).not.toHaveBeenCalled();
  });

  test('report_deviation opens the form instead of transitioning', async () => {
    const execution = useExecutionStore();
    await execution.open('t1');
    await execution.runTransition('report_deviation');
    expect(execution.deviationOpen).toBe(true);
    expect(api.transition).not.toHaveBeenCalled();
  });

  test('deviation submit sends {note, stepIndex, filePath} and closes the form', async () => {
    const execution = useExecutionStore();
    await execution.open('t1');
    execution.openDeviationForm();
    execution.deviationForm = { note: '依赖方向不对', stepIndex: 1, filePath: 'src/auth.ts' };
    await execution.submitDeviation();
    expect(api.transition).toHaveBeenCalledWith('t1', 'report_deviation', { deviation: { note: '依赖方向不对', stepIndex: 1, filePath: 'src/auth.ts' } });
    expect(execution.deviationOpen).toBe(false);
    expect(feedback.showToast).toHaveBeenCalledWith('偏差已记录，Architect 正在裁决。');
  });

  test('a blank deviation note is refused without calling IPC', async () => {
    const execution = useExecutionStore();
    await execution.open('t1');
    execution.openDeviationForm();
    execution.deviationForm.note = '   ';
    expect(await execution.submitDeviation()).toBe(false);
    expect(api.transition).not.toHaveBeenCalled();
    expect(feedback.showToast).toHaveBeenCalledWith('请填写偏差说明。');
    expect(execution.deviationOpen).toBe(true);
  });

  test('review polling follows a running review and announces the outcome', async () => {
    vi.useFakeTimers();
    current.task = taskView({ status: 'in_review', review: running });
    const execution = useExecutionStore();
    await execution.open('t1');
    api.getTask.mockClear();

    await vi.advanceTimersByTimeAsync(REVIEW_POLL_MS);
    expect(api.getTask).toHaveBeenCalledTimes(1);

    current.task = taskView({ status: 'done', review: { ...running, status: 'failed', error: { code: 'agent_timeout', message: 'x' } } });
    await vi.advanceTimersByTimeAsync(REVIEW_POLL_MS);
    expect(execution.current?.status).toBe('done');
    expect(feedback.showToast).toHaveBeenCalledWith('QA 审查失败：智能体超过 3 分钟没有完成，已停止。');

    // Settled: no further polls.
    api.getTask.mockClear();
    await vi.advanceTimersByTimeAsync(REVIEW_POLL_MS * 3);
    expect(api.getTask).not.toHaveBeenCalled();
  });

  test('close() stops review polling', async () => {
    vi.useFakeTimers();
    current.task = taskView({ status: 'in_review', review: running });
    const execution = useExecutionStore();
    await execution.open('t1');
    api.getTask.mockClear();
    execution.close();
    await vi.advanceTimersByTimeAsync(REVIEW_POLL_MS * 4);
    expect(api.getTask).not.toHaveBeenCalled();
    expect(execution.current).toBeNull();
  });

  test('baseline polling merges the measurement until it settles; close() stops it', async () => {
    vi.useFakeTimers();
    const measuring: ipc.BaselineChecks = { status: 'measuring', reason: null, commit: 'abc', checks: {}, startedAt: '', finishedAt: null };
    current.task = taskView({ baselineChecks: measuring });
    const execution = useExecutionStore();
    await execution.open('t1');
    api.getTask.mockClear();

    await vi.advanceTimersByTimeAsync(BASELINE_POLL_MS);
    expect(api.getTask).toHaveBeenCalledTimes(1);
    current.task = taskView({ baselineChecks: { ...measuring, status: 'measured' } });
    await vi.advanceTimersByTimeAsync(BASELINE_POLL_MS);
    expect(execution.current?.baselineChecks?.status).toBe('measured');
    api.getTask.mockClear();
    await vi.advanceTimersByTimeAsync(BASELINE_POLL_MS * 3);
    expect(api.getTask).not.toHaveBeenCalled();

    current.task = taskView({ baselineChecks: measuring });
    await execution.open('t1');
    api.getTask.mockClear();
    execution.close();
    await vi.advanceTimersByTimeAsync(BASELINE_POLL_MS * 3);
    expect(api.getTask).not.toHaveBeenCalled();
  });

  test('a failed step save reports it and leaves progress unchanged', async () => {
    const execution = useExecutionStore();
    await execution.open('t1');
    api.setStepDone.mockResolvedValueOnce({ ok: false, error: { code: 'invalid_state', message: 'x' } } as never);
    expect(await execution.setStepDone(0, true)).toBe(false);
    expect(execution.current?.completedSteps).toEqual([]);
    expect(feedback.showToast).toHaveBeenCalledWith('保存进度失败：当前状态下不能执行这个操作。');
    expect(await execution.setStepDone(1, true)).toBe(true);
    expect(execution.current?.completedSteps).toEqual([1]);
  });

  test('verification acceptance evidence overrides the review until the next reload', async () => {
    const execution = useExecutionStore();
    await execution.open('t1');
    const acceptance = [{ text: '登录成功', test: 'login works', status: 'verified', verified: true, manual: false }] as ipc.CriterionEvidence[];
    api.verify.run.mockResolvedValueOnce({
      ok: true,
      data: {
        kind: 'test',
        command: 'npm test',
        exitCode: 0,
        timedOut: false,
        durationMs: 1200,
        output: '',
        results: [],
        summary: { total: 1, passed: 1, failed: 0, skipped: 0, ok: true },
        report: { format: 'stdout', trusted: true, problem: null },
        check: { stage: 'submit', blocking: true },
        acceptance,
      },
    });
    await execution.runVerification('test');
    expect(api.verify.run).toHaveBeenCalledWith('test', 't1');
    expect(execution.verifyKind).toBe('test');
    expect(execution.acceptanceOverride).toEqual(acceptance);
    await execution.reloadCurrent();
    expect(execution.acceptanceOverride).toBeNull();
  });
});
