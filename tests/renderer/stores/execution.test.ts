// @vitest-environment happy-dom
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

import { useExecutionStore } from '../../../src/renderer/src/stores/execution.ts';
import { useAppStore } from '../../../src/renderer/src/stores/app.ts';
import { useTasksStore } from '../../../src/renderer/src/stores/tasks.ts';
import * as feedback from '../../../src/renderer/src/lib/feedback.ts';
import type * as packageTypes from '../../../src/shared/ipc/packages.ts';
import type * as workspaceTypes from '../../../src/shared/ipc/workspace.ts';
import { installApi, taskView } from '../execution_fakes.ts';

vi.mock('../../../src/renderer/src/lib/feedback.ts', () => {
  const showToast = vi.fn();
  // announceAgent adds a system notification only in the background; tests see the toast.
  return { showToast, announceAgent: (...args: unknown[]) => showToast(...args), confirmAction: vi.fn(async () => true), openDialogs: { value: 0 } };
});

const running: packageTypes.Review = { status: 'running', error: null, startedAt: '', finishedAt: null };

let current: { task: packageTypes.TaskView };
let api: ReturnType<typeof installApi>;

beforeEach(() => {
  setActivePinia(createPinia());
  current = { task: taskView() };
  api = installApi(current);
  vi.mocked(feedback.showToast).mockClear();
  vi.mocked(feedback.confirmAction).mockClear();
});

describe('execution store', () => {
  test('open() loads the package, navigates and reads the diff', async () => {
    const execution = useExecutionStore();
    await execution.open('t1');
    expect(useAppStore().view).toBe('execution');
    expect(execution.current?.id).toBe('t1');
    expect(execution.diffHint).toBe('相对基线 abcdef12');
  });

  test('open() reports a failed load and stays put', async () => {
    api.tasks.get.mockResolvedValueOnce({ ok: false, error: { code: 'x', message: '没有这个工作包' } } as never);
    const execution = useExecutionStore();
    await execution.open('missing');
    expect(useAppStore().view).toBe('queue');
    expect(feedback.showToast).toHaveBeenCalledWith('打开工作包失败：没有这个工作包');
  });

  test('a transition calls IPC, then reloads the package and the queue', async () => {
    const execution = useExecutionStore();
    await execution.open('t1');
    api.tasks.get.mockClear();
    current.task = taskView({ status: 'in_review', statusLabel: '审查中' });
    await execution.runTransition('submit_for_review');
    expect(api.packages.transition).toHaveBeenCalledWith('t1', 'submit_for_review');

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
    expect(api.packages.transition).toHaveBeenCalledTimes(1);
    expect(execution.transitioning).toBe(null);
  });

  test('a failed transition clears the in-flight state', async () => {
    const execution = useExecutionStore();
    await execution.open('t1');
    api.packages.transition.mockResolvedValueOnce({ ok: false, error: { code: 'x', message: 'x' } } as never);
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
    expect(api.packages.transition).not.toHaveBeenCalled();
  });

  test('report_deviation opens the form instead of transitioning', async () => {
    const execution = useExecutionStore();
    await execution.open('t1');
    await execution.runTransition('report_deviation');
    expect(execution.deviationOpen).toBe(true);
    expect(api.packages.transition).not.toHaveBeenCalled();
  });

  test('deviation submit sends {note, stepIndex, filePath} and closes the form', async () => {
    const execution = useExecutionStore();
    await execution.open('t1');
    execution.openDeviationForm();
    execution.deviationForm = { note: '依赖方向不对', stepIndex: 1, filePath: 'src/auth.ts' };
    await execution.submitDeviation();
    expect(api.packages.transition).toHaveBeenCalledWith('t1', 'report_deviation', {
      deviation: { note: '依赖方向不对', stepIndex: 1, filePath: 'src/auth.ts' },
    });
    expect(execution.deviationOpen).toBe(false);
    expect(feedback.showToast).toHaveBeenCalledWith('偏差已记录，Architect 正在裁决。');
  });

  test('a blank deviation note is refused without calling IPC', async () => {
    const execution = useExecutionStore();
    await execution.open('t1');
    execution.openDeviationForm();
    execution.deviationForm.note = '   ';
    expect(await execution.submitDeviation()).toBe(false);
    expect(api.packages.transition).not.toHaveBeenCalled();
    expect(feedback.showToast).toHaveBeenCalledWith('请填写偏差说明。');
    expect(execution.deviationOpen).toBe(true);
  });

  test('state events refresh a running review and announce the outcome', async () => {
    current.task = taskView({ status: 'in_review', review: running });
    const execution = useExecutionStore();
    await execution.open('t1');
    api.tasks.get.mockClear();

    current.task = taskView({ status: 'done', review: { ...running, status: 'failed', error: { code: 'agent_timeout', message: 'x' } } });
    api.emitState({ repositoryId: null, domains: ['packages'] });
    await vi.waitFor(() => expect(execution.current?.status).toBe('done'));
    expect(feedback.showToast).toHaveBeenCalledWith('QA 审查失败：智能体超过 3 分钟没有完成，已停止。');

    api.tasks.get.mockClear();
    api.emitState({ repositoryId: null, domains: ['requirements'] });
    api.emitState({ repositoryId: 'other-repo', domains: ['packages'] });
    await Promise.resolve();
    expect(api.tasks.get).not.toHaveBeenCalled();
  });

  test('close() unsubscribes from state events', async () => {
    current.task = taskView({ status: 'in_review', review: running });
    const execution = useExecutionStore();
    await execution.open('t1');
    api.tasks.get.mockClear();
    execution.close();
    api.emitState({ repositoryId: null, domains: ['packages'] });
    await Promise.resolve();
    expect(api.tasks.get).not.toHaveBeenCalled();
    expect(execution.current).toBeNull();
  });

  test('state events refresh a baseline measurement until it settles', async () => {
    const measuring: workspaceTypes.BaselineChecks = { status: 'measuring', reason: null, commit: 'abc', checks: {}, startedAt: '', finishedAt: null };
    current.task = taskView({ baselineChecks: measuring });
    const execution = useExecutionStore();
    await execution.open('t1');
    api.tasks.get.mockClear();

    current.task = taskView({ baselineChecks: { ...measuring, status: 'measured' } });
    api.emitState({ repositoryId: null, domains: ['workspace'] });
    await vi.waitFor(() => expect(execution.current?.baselineChecks?.status).toBe('measured'));
    api.tasks.get.mockClear();
    api.emitState({ repositoryId: null, domains: ['requirements'] });
    await Promise.resolve();
    expect(api.tasks.get).not.toHaveBeenCalled();
  });

  test('a failed step save reports it and leaves progress unchanged', async () => {
    const execution = useExecutionStore();
    await execution.open('t1');
    api.packages.setStepDone.mockResolvedValueOnce({ ok: false, error: { code: 'invalid_state', message: 'x' } } as never);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await execution.setStepDone(0, true)).toBe(false);
    log.mockRestore();
    expect(execution.current?.completedSteps).toEqual([]);
    expect(feedback.showToast).toHaveBeenCalledWith('保存进度失败：当前状态下不能执行这个操作。');
    expect(await execution.setStepDone(1, true)).toBe(true);
    expect(execution.current?.completedSteps).toEqual([1]);
  });

  test('verification acceptance evidence overrides the review until the next reload', async () => {
    const execution = useExecutionStore();
    await execution.open('t1');
    const acceptance = [{ text: '登录成功', test: 'login works', status: 'verified', verified: true, manual: false }] as workspaceTypes.CriterionEvidence[];
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

describe('queue actions', () => {
  test('claiming while another package is in progress asks first, and declining claims nothing', async () => {
    current.task = taskView({ status: 'pending', humanTransitions: ['claim'] });
    useTasksStore().tasks = [taskView({ id: 'other', title: '另一个包', status: 'in_progress' })];
    const execution = useExecutionStore();
    vi.mocked(feedback.confirmAction).mockResolvedValueOnce(false);
    await execution.claimFromQueue('t1');
    expect(vi.mocked(feedback.confirmAction).mock.calls[0][0].title).toBe('已经有 1 个工作包在执行中');
    expect(api.packages.transition).not.toHaveBeenCalled();

    vi.mocked(feedback.confirmAction).mockResolvedValue(true);
    await execution.claimFromQueue('t1');
    expect(execution.claimOpen).toBe(true);
    await execution.confirmClaim();
    expect(api.packages.transition).toHaveBeenCalledWith('t1', 'claim', { mode: 'self' });
  });

  test('claiming with nothing else in progress does not ask about it', async () => {
    current.task = taskView({ status: 'pending', humanTransitions: ['claim'] });
    useTasksStore().tasks = [];
    vi.mocked(feedback.confirmAction).mockResolvedValue(true);
    const execution = useExecutionStore();
    await execution.claimFromQueue('t1');
    expect(vi.mocked(feedback.confirmAction).mock.calls.map(([options]) => options.title)).not.toContain('已经有 1 个工作包在执行中');
    await execution.confirmClaim();
    expect(api.packages.transition).toHaveBeenCalledWith('t1', 'claim', { mode: 'self' });
  });

  test('the claim dialog preselects the recommended mode and claims with the one picked', async () => {
    current.task = taskView({ status: 'pending', humanTransitions: ['claim'], recommendedMode: { mode: 'practice', reason: '能练到写法。' } });
    useTasksStore().tasks = [];
    const execution = useExecutionStore();
    await execution.claimFromQueue('t1');
    expect(execution.claimMode).toBe('practice');
    expect(api.packages.transition).not.toHaveBeenCalled();
    execution.claimMode = 'ai';
    await execution.confirmClaim();
    expect(execution.claimOpen).toBe(false);
    expect(api.packages.transition).toHaveBeenCalledWith('t1', 'claim', { mode: 'ai' });
  });

  test('waiving a dependency asks, then updates the package everywhere', async () => {
    const dependency = { id: 'r1-wp1', title: '实现用例', status: 'in_progress' as const, waived: false, blocking: true };
    current.task = taskView({ status: 'pending', dependencies: [dependency] });
    useTasksStore().tasks = [current.task];
    const execution = useExecutionStore();
    vi.mocked(feedback.confirmAction).mockResolvedValueOnce(false);
    expect(await execution.waiveDependency(current.task, dependency)).toBe(false);
    expect(api.packages.waiveDependency).not.toHaveBeenCalled();

    vi.mocked(feedback.confirmAction).mockResolvedValueOnce(true);
    expect(await execution.waiveDependency(current.task, dependency)).toBe(true);
    expect(api.packages.waiveDependency).toHaveBeenCalledWith('t1', 'r1-wp1');
    expect(useTasksStore().tasks[0].dependencies[0].blocking).toBe(false);
  });
});
