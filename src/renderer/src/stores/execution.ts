// The work package open in the execution view: its state, the diff against
// the baseline, verification runs, the deviation form, and the polls that
// follow background agents (QA, Architect) and baseline measurement.
import { defineStore } from 'pinia';
import { ref } from 'vue';

import { call } from '@/lib/ipc.ts';
import { describeError, describeErrorInfo } from '@/lib/errors.ts';
import { confirmAction, showToast } from '@/lib/feedback.ts';
import type { ConfirmOptions } from '@/lib/feedback.ts';
import type { IconName } from '@/lib/icons.ts';
import type * as ipc from '@shared/ipc_types.ts';
import { useAppStore } from './app.ts';
import { useTasksStore } from './tasks.ts';

export type ActionSpec = { name: ipc.HumanTransition; label: string; icon: IconName; primary?: boolean; danger?: boolean };

// Human-triggerable transitions, in the order they should appear.
export const ACTIONS: ActionSpec[] = [
  { name: 'claim', label: '开始执行', icon: 'play', primary: true },
  { name: 'submit_for_review', label: '提交审查', icon: 'send', primary: true },
  { name: 'accepted', label: '验收通过', icon: 'check-circle', primary: true },
  { name: 'unblock', label: '解除阻塞', icon: 'unlock', primary: true },
  { name: 'report_deviation', label: '报告偏差', icon: 'flag', danger: true },
  { name: 'override_dismissal', label: '不同意驳回，要求重新规划', icon: 'flag', danger: true },
  { name: 'acceptance_rejected', label: '打回修改', icon: 'undo', danger: true },
  { name: 'revert_replan', label: '撤销重新规划', icon: 'undo' },
  { name: 'block', label: '标记阻塞', icon: 'ban' },
  { name: 'release', label: '放回队列', icon: 'undo' },
];

export const TRANSITION_TOASTS: Partial<Record<ipc.HumanTransition, string>> = {
  claim: '已领取，基线已记录。',
  submit_for_review: '已提交，QA 正在审查。',
  block: '已标记为阻塞。',
  unblock: '已解除阻塞。',
  release: '已放回队列。',
  accepted: '已验收，工作包完成。',
  acceptance_rejected: '已打回，工作包回到执行中。',
  override_dismissal: '已提出异议，Architect 正在重新规划。',
  revert_replan: '已撤销重新规划，恢复原计划和进度。',
};

// Transitions that need a confirmation first.
export const TRANSITION_CONFIRMS: Partial<Record<ipc.HumanTransition, ConfirmOptions>> = {
  acceptance_rejected: { title: '打回这个工作包？', body: '工作包会回到执行中，你需要修改后重新提交审查。', accept: '打回', danger: true },
  revert_replan: { title: '撤销重新规划？', body: '恢复 Architect 修订前的计划和执行进度，偏差记录会保留。', accept: '撤销' },
};

export const VERIFY_LABELS: Record<ipc.CheckKind, string> = { test: '测试', lint: 'Lint', build: 'Build', smoke: '冒烟测试' };

export const REVIEW_POLL_MS = 1500;
export const BASELINE_POLL_MS = 1000;

const agentRunning = (task: ipc.TaskView | null) => task?.review?.status === 'running' || task?.adjudication?.status === 'running';

export type DeviationForm = { note: string; stepIndex: number | null; filePath: string | null };

export const useExecutionStore = defineStore('execution', () => {
  // ========== Current package ==========
  const current = ref<ipc.TaskView | null>(null);
  // Acceptance evidence from the last verification run; falls back to the review's.
  const acceptanceOverride = ref<ipc.CriterionEvidence[] | null>(null);

  // Re-reads the open package and the queue after a state change.
  const reloadCurrent = async () => {
    if (!current.value) return;
    current.value = await call(window.taskpilot.getTask(current.value.id));
    acceptanceOverride.value = null;
    watchReview();
    watchBaseline();
    await refreshDiff();
    await useTasksStore().reloadQueue();
  };

  const open = async (id: string) => {
    let task: ipc.TaskView;
    try {
      task = await call(window.taskpilot.getTask(id));
    } catch (error) {
      console.error(error);
      showToast(`打开工作包失败：${describeError(error)}`);
      return;
    }
    if (!(await useAppStore().navigate('execution'))) return;
    stopTimers();
    current.value = task;
    acceptanceOverride.value = null;
    diff.value = null;
    diffHint.value = '相对领取时的基线';
    verifyKind.value = null;
    verifyRunning.value = false;
    verifyResult.value = null;
    verifyError.value = null;
    deviationOpen.value = false;
    watchReview();
    watchBaseline();
    await refreshDiff();
  };

  // Leaves the execution view; stops any polling.
  const close = () => {
    stopTimers();
    current.value = null;
    deviationOpen.value = false;
  };

  // ========== Steps ==========
  const setStepDone = async (stepIndex: number, done: boolean) => {
    if (!current.value) return false;
    try {
      const state = await call(window.taskpilot.setStepDone(current.value.id, stepIndex, done));
      current.value = { ...current.value, completedSteps: state.completedSteps };
      return true;
    } catch (error) {
      console.error(error);
      showToast(`保存进度失败：${describeError(error)}`);
      return false;
    }
  };

  // ========== Baseline ==========
  let baselineTimer: ReturnType<typeof setTimeout> | null = null;

  const stopBaselinePolling = () => {
    if (baselineTimer) clearTimeout(baselineTimer);
    baselineTimer = null;
  };

  // Claiming starts the measurement in the background; follow it.
  const watchBaseline = () => {
    stopBaselinePolling();
    const task = current.value;
    if (!task?.baseline || (task.baselineChecks && task.baselineChecks.status !== 'measuring')) return;
    const id = task.id;
    baselineTimer = setTimeout(() => {
      baselineTimer = null;
      pollBaseline(id).catch((error) => console.error(error));
    }, BASELINE_POLL_MS);
  };

  const pollBaseline = async (id: string) => {
    if (current.value?.id !== id) return;
    try {
      const fresh = await call(window.taskpilot.getTask(id));
      if (current.value?.id !== id) return;
      current.value = { ...current.value, baselineChecks: fresh.baselineChecks };
      watchBaseline();
    } catch (error) {
      // Try again on the next reload.
      console.error(error);
    }
  };

  const remeasureBaseline = async () => {
    if (!current.value) return;
    try {
      const task = await call(window.taskpilot.measureBaseline(current.value.id));
      // The new measurement replaces the old record once it starts.
      const measuring: ipc.BaselineChecks = {
        status: 'measuring',
        reason: null,
        commit: task.baseline ?? '',
        checks: {},
        startedAt: new Date().toISOString(),
        finishedAt: null,
      };
      current.value = { ...task, baselineChecks: measuring };
      watchBaseline();
    } catch (error) {
      console.error(error);
      showToast(`无法重新测量：${describeError(error)}`, 'error');
    }
  };

  // ========== Review and adjudication ==========
  let reviewTimer: ReturnType<typeof setTimeout> | null = null;

  const stopReviewPolling = () => {
    if (reviewTimer) clearTimeout(reviewTimer);
    reviewTimer = null;
  };

  const announceReview = (task: ipc.TaskView) => {
    const review = task.review;
    if (!review) return;
    if (review.status === 'passed') showToast(task.status === 'done' ? 'QA 审查通过，工作包已完成。' : 'QA 审查通过，有几项需要你确认后验收。');
    else if (review.status === 'rejected') showToast('QA 审查未通过，请查看问题。', 'error');
    else if (review.status === 'failed' && review.error.code !== 'agent_cancelled') showToast(`QA 审查失败：${describeErrorInfo(review.error)}`);
  };

  const announceAdjudication = (task: ipc.TaskView) => {
    const adjudication = task.adjudication;
    if (adjudication?.status === 'failed') {
      if (adjudication.error.code !== 'agent_cancelled') showToast(`Architect 裁决失败：${describeErrorInfo(adjudication.error)}`);
      return;
    }
    const decision = task.deviations[task.deviations.length - 1]?.resolution?.decision;
    if (decision === 'dismiss') showToast('Architect 驳回了偏差，请查看理由后继续。');
    else if (decision === 'replan') showToast('Architect 已重新规划，工作包回到队列。');
  };

  // Re-reads the open package while QA or Architect runs, until it settles.
  const watchReview = () => {
    stopReviewPolling();
    const before = current.value;
    if (!before || !agentRunning(before)) return;
    reviewTimer = setTimeout(() => {
      reviewTimer = null;
      pollReview(before).catch((error) => console.error(error));
    }, REVIEW_POLL_MS);
  };

  const pollReview = async (before: ipc.TaskView) => {
    const id = before.id;
    let task: ipc.TaskView;
    try {
      task = await call(window.taskpilot.getTask(id));
    } catch (error) {
      console.error(error);
      if (current.value?.id === id) watchReview();
      return;
    }
    if (current.value?.id !== id) return; // the user moved on
    if (agentRunning(task)) {
      current.value = task;
      watchReview();
      return;
    }
    try {
      await reloadCurrent();
    } catch (error) {
      console.error(error);
    }
    if (before.review?.status === 'running') announceReview(task);
    if (before.adjudication?.status === 'running') announceAdjudication(task);
  };

  const runReviewAction = async (action: 'cancel' | 'retry') => {
    if (!current.value) return;
    try {
      if (action === 'cancel') await call(window.taskpilot.review.cancel(current.value.id));
      else await call(window.taskpilot.review.retry(current.value.id));
      await reloadCurrent();
    } catch (error) {
      console.error(error);
      showToast(`操作失败：${describeError(error)}`);
    }
  };

  const runDeviationAction = async (action: 'cancel' | 'retry') => {
    if (!current.value) return;
    try {
      if (action === 'cancel') await call(window.taskpilot.deviation.cancel(current.value.id));
      else await call(window.taskpilot.deviation.retry(current.value.id));
      await reloadCurrent();
    } catch (error) {
      console.error(error);
      showToast(`操作失败：${describeError(error)}`);
    }
  };

  const stopTimers = () => {
    stopReviewPolling();
    stopBaselinePolling();
  };

  // ========== Diff ==========
  const diff = ref<ipc.DiffStat | null>(null);
  const diffHint = ref('相对领取时的基线');
  // Bumped on every refresh so expanded file patches reload.
  const diffVersion = ref(0);

  // Reloads diff state for the open package; no-op before it is claimed.
  const refreshDiff = async () => {
    const task = current.value;
    if (!task?.baseline) {
      diff.value = null;
      diffVersion.value += 1;
      return;
    }
    try {
      const stat = await call(window.taskpilot.diff.stat(task.id));
      if (current.value?.id !== task.id) return;
      diff.value = stat;
      diffVersion.value += 1;
      const out = stat.scope.outOfScope.length;
      diffHint.value = out > 0 ? `${out} 个文件超出工作包范围` : `相对基线 ${task.baseline.slice(0, 8)}`;
    } catch (error) {
      console.error(error);
      showToast(`读取改动失败：${describeError(error)}`);
    }
  };

  // ========== Verification ==========
  const verifyKind = ref<ipc.CheckKind | null>(null);
  const verifyRunning = ref(false);
  const verifyResult = ref<ipc.VerifyRun | null>(null);
  const verifyError = ref<string | null>(null);

  const runVerification = async (kind: ipc.CheckKind) => {
    const task = current.value;
    if (!task || verifyRunning.value) return;
    verifyKind.value = kind;
    verifyRunning.value = true;
    verifyResult.value = null;
    verifyError.value = null;
    try {
      const result = await call(window.taskpilot.verify.run(kind, task.id));
      if (current.value?.id !== task.id) return;
      verifyResult.value = result;
      if (result.acceptance) acceptanceOverride.value = result.acceptance;
    } catch (error) {
      console.error(error);
      verifyError.value = describeError(error);
    } finally {
      verifyRunning.value = false;
    }
  };

  // ========== Transitions ==========
  const runTransition = async (name: ipc.HumanTransition) => {
    if (!current.value) return;
    if (name === 'report_deviation') {
      openDeviationForm();
      return;
    }
    const confirm = TRANSITION_CONFIRMS[name];
    if (confirm && !(await confirmAction(confirm))) return;
    try {
      await call(window.taskpilot.transition(current.value.id, name));
      await reloadCurrent();
      showToast(TRANSITION_TOASTS[name] ?? '状态已更新。');
    } catch (error) {
      console.error(error);
      showToast(`操作失败：${describeError(error)}`);
    }
  };

  // ========== Modals ==========
  // True while the deviation dialog is open, so Escape closes it first.
  const deviationOpen = ref(false);
  const deviationForm = ref<DeviationForm>({ note: '', stepIndex: null, filePath: null });

  const openDeviationForm = () => {
    deviationForm.value = { note: '', stepIndex: null, filePath: null };
    deviationOpen.value = true;
  };

  const closeDeviationForm = () => {
    deviationOpen.value = false;
  };

  // Resolves false when the note is blank, so the view can refocus it.
  const submitDeviation = async () => {
    if (!current.value) return false;
    const { note, stepIndex, filePath } = deviationForm.value;
    if (!note.trim()) {
      showToast('请填写偏差说明。');
      return false;
    }
    try {
      await call(window.taskpilot.transition(current.value.id, 'report_deviation', { deviation: { note, stepIndex, filePath } }));
      closeDeviationForm();
      await reloadCurrent();
      showToast('偏差已记录，Architect 正在裁决。');
    } catch (error) {
      console.error(error);
      showToast(`提交失败：${describeError(error)}`);
    }
    return true;
  };

  return {
    // Current package
    current,
    acceptanceOverride,
    open,
    close,
    reloadCurrent,
    // Steps
    setStepDone,
    // Baseline
    remeasureBaseline,
    // Review and adjudication
    runReviewAction,
    runDeviationAction,
    // Diff
    diff,
    diffHint,
    diffVersion,
    refreshDiff,
    // Verification
    verifyKind,
    verifyRunning,
    verifyResult,
    verifyError,
    runVerification,
    // Transitions
    runTransition,
    // Modals
    deviationOpen,
    deviationForm,
    openDeviationForm,
    closeDeviationForm,
    submitDeviation,
  };
});
