// The work package open in the execution view: its state, the diff against
// the baseline, verification runs, the deviation form, and the polls that
// follow background agents (QA, Architect) and baseline measurement.
import { defineStore } from 'pinia';
import { ref } from 'vue';

import { call } from '@/lib/ipc.ts';
import { describeError, describeErrorInfo } from '@/lib/errors.ts';
import { defaultMode } from '@/lib/execution_mode.ts';
import { announceAgent, confirmAction, showToast } from '@/lib/feedback.ts';
import type { ConfirmOptions } from '@/lib/feedback.ts';
import type { IconName } from '@/lib/icons.ts';
import type * as packageTypes from '@shared/ipc/packages.ts';
import type * as workspaceTypes from '@shared/ipc/workspace.ts';
import { useAppStore } from './app.ts';
import { useTasksStore } from './tasks.ts';

export type ActionSpec = { name: packageTypes.HumanTransition; label: string; icon: IconName; primary?: boolean; danger?: boolean };

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

export const TRANSITION_TOASTS: Partial<Record<packageTypes.HumanTransition, string>> = {
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
export const TRANSITION_CONFIRMS: Partial<Record<packageTypes.HumanTransition, ConfirmOptions>> = {
  acceptance_rejected: { title: '打回这个工作包？', body: '工作包会回到执行中，你需要修改后重新提交审查。', accept: '打回', danger: true },
  revert_replan: { title: '撤销重新规划？', body: '恢复 Architect 修订前的计划和执行进度，偏差记录会保留。', accept: '撤销' },
};

export const VERIFY_LABELS: Record<workspaceTypes.CheckKind, string> = { test: '测试', lint: '代码检查', build: '构建', smoke: '冒烟测试' };

export const REVIEW_POLL_MS = 1500;
export const BASELINE_POLL_MS = 1000;

// Practice runs count too: the reference and the grade land in the open page.
const agentRunning = (task: packageTypes.TaskView | null) =>
  task?.review?.status === 'running' ||
  task?.adjudication?.status === 'running' ||
  task?.referenceRun?.status === 'running' ||
  task?.grade?.status === 'running' ||
  task?.grade?.status === 'waiting';

export type DeviationForm = { note: string; stepIndex: number | null; filePath: string | null };

export const useExecutionStore = defineStore('execution', () => {
  // ========== Current package ==========
  const current = ref<packageTypes.TaskView | null>(null);
  // Acceptance evidence from the last verification run; falls back to the review's.
  const acceptanceOverride = ref<workspaceTypes.CriterionEvidence[] | null>(null);

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
    let task: packageTypes.TaskView;
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

  // Replace the open task after a coding or other background IPC action. The
  // queue entry is updated in place so the sidebar never lags behind the view.
  const adoptTask = (task: packageTypes.TaskView) => {
    if (current.value?.id !== task.id) return false;
    current.value = task;
    useTasksStore().tasks = useTasksStore().tasks.map((entry) => (entry.id === task.id ? task : entry));
    watchReview();
    watchBaseline();
    return true;
  };

  // ========== Steps ==========
  const setStepDone = async (stepIndex: number, done: boolean) => {
    if (!current.value) return false;
    const id = current.value.id;
    try {
      const state = await call(window.taskpilot.setStepDone(id, stepIndex, done));
      if (current.value?.id === id) current.value = { ...current.value, completedSteps: state.completedSteps };
      // Keep the queue's progress in step without reloading it.
      const tasks = useTasksStore();
      tasks.tasks = tasks.tasks.map((task) => (task.id === id ? { ...task, completedSteps: state.completedSteps } : task));
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
      const measuring: workspaceTypes.BaselineChecks = {
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

  const announceReview = (task: packageTypes.TaskView) => {
    const review = task.review;
    if (!review) return;
    if (review.status === 'passed') announceAgent(task.status === 'done' ? 'QA 审查通过，工作包已完成。' : 'QA 审查通过，有几项需要你确认后验收。');
    else if (review.status === 'rejected') announceAgent('QA 审查未通过，请查看问题。', 'error');
    else if (review.status === 'failed' && review.error.code !== 'agent_cancelled') announceAgent(`QA 审查失败：${describeErrorInfo(review.error)}`);
  };

  const announceAdjudication = (task: packageTypes.TaskView) => {
    const adjudication = task.adjudication;
    if (adjudication?.status === 'failed') {
      if (adjudication.error.code !== 'agent_cancelled') announceAgent(`Architect 裁决失败：${describeErrorInfo(adjudication.error)}`);
      return;
    }
    const decision = task.deviations[task.deviations.length - 1]?.resolution?.decision;
    if (decision === 'dismiss') announceAgent('Architect 驳回了偏差，请查看理由后继续。');
    else if (decision === 'replan') announceAgent('Architect 已重新规划，工作包回到队列。');
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

  const pollReview = async (before: packageTypes.TaskView) => {
    const id = before.id;
    let task: packageTypes.TaskView;
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
    if (before.grade && before.grade.status !== 'done' && task.grade?.status === 'done') announceAgent('导师判完卷了，参考答案也可以看了。');
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
  const diff = ref<workspaceTypes.DiffStat | null>(null);
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

  // One file's unified diff, fetched when its row is first expanded.
  const diffFile = (taskId: string, path: string) => call(window.taskpilot.diff.file(taskId, path));

  // ========== Verification ==========
  const verifyKind = ref<workspaceTypes.CheckKind | null>(null);
  const verifyRunning = ref(false);
  const verifyResult = ref<workspaceTypes.VerifyRun | null>(null);
  const verifyError = ref<string | null>(null);

  const runVerification = async (kind: workspaceTypes.CheckKind) => {
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
  // Claiming on a dirty tree records no baseline, so failures that were
  // already there would count against the package. Say so before claiming.
  const confirmDirtyClaim = async () => {
    const info = await useAppStore().refreshWorkspaceStatus();
    if (!info?.configured || !info.dirty) return true;
    return confirmAction({
      title: '项目里还有没提交的改动',
      body: `有 ${info.changedFiles} 个文件改过但还没提交。建议先把它们提交（上一个工作包完成后可以在「保存到 git」里提交），或者还原。现在开始也可以，但 TaskPilot 分不清哪些问题是这次引入的。`,
      accept: '仍然开始',
    });
  };

  // The transition in flight; its button spins and the others wait.
  const transitioning = ref<packageTypes.HumanTransition | null>(null);

  // [人工决策-2026-10-14] 同时只做 1 个是软提示：已有执行中的包时，确认后仍可领取。
  const confirmBusyClaim = async (id: string) => {
    const others = useTasksStore().tasks.filter((task) => task.status === 'in_progress' && task.id !== id);
    if (!others.length) return true;
    return confirmAction({
      title: `已经有 ${others.length} 个工作包在执行中`,
      body: `「${others[0].title}」${others.length > 1 ? ` 等 ${others.length} 个` : ''}还没做完。同时做几个包时，改动容易混在一起，QA 也分不清哪些属于哪个包。建议先做完或放回队列，再开始新的。`,
      accept: '仍然开始',
    });
  };

  const runTransition = async (name: packageTypes.HumanTransition) => {
    if (!current.value || transitioning.value) return;
    if (name === 'report_deviation') {
      openDeviationForm();
      return;
    }
    const confirm = TRANSITION_CONFIRMS[name];
    if (confirm && !(await confirmAction(confirm))) return;
    if (name === 'claim') {
      if (!(await confirmBusyClaim(current.value.id)) || !(await confirmDirtyClaim())) return;
      // The claim itself goes out from the dialog, with the chosen mode.
      claimMode.value = defaultMode(current.value);
      claimOpen.value = true;
      return;
    }
    if (name === 'submit_for_review' && current.value.codingRun?.status === 'applied') {
      const proceed = await confirmAction({
        title: '确认提交审查？',
        body: '编码 Agent 的改动已写入工作区。验证和 QA 将以当前主机用户权限执行，请先确认文件范围和命令风险。',
        accept: '仍然提交审查',
      });
      if (!proceed) return;
    }
    await sendTransition(name);
  };

  const sendTransition = async (name: packageTypes.HumanTransition, options?: packageTypes.TransitionOptions) => {
    if (!current.value) return;
    transitioning.value = name;
    try {
      await call(options ? window.taskpilot.transition(current.value.id, name, options) : window.taskpilot.transition(current.value.id, name));
      await reloadCurrent();
      showToast(TRANSITION_TOASTS[name] ?? '状态已更新。');
    } catch (error) {
      console.error(error);
      showToast(`操作失败：${describeError(error)}`);
    } finally {
      transitioning.value = null;
    }
  };

  // ========== Practice ==========
  // The reference patch, fetched once the main process allows it.
  const reference = ref<{ id: string; patch: string } | null>(null);
  const referenceError = ref<string | null>(null);

  const loadReference = async () => {
    const task = current.value;
    if (!task?.referenceRun) return;
    referenceError.value = null;
    try {
      reference.value = { id: task.referenceRun.id, patch: await call(window.taskpilot.practice.reference(task.id)) };
    } catch (error) {
      console.error(error);
      referenceError.value = describeError(error);
    }
  };

  const regrade = async (skipReference: boolean) => {
    if (!current.value) return;
    try {
      adoptTask(await call(window.taskpilot.practice.grade(current.value.id, skipReference)));
    } catch (error) {
      console.error(error);
      showToast(`判卷没能开始：${describeError(error)}`);
    }
  };

  // ========== Claim dialog ==========
  // Open while the developer picks who writes the code.
  const claimOpen = ref(false);
  const claimMode = ref<packageTypes.ExecutionMode>('self');

  const closeClaim = () => {
    claimOpen.value = false;
  };

  const confirmClaim = async () => {
    claimOpen.value = false;
    await sendTransition('claim', { mode: claimMode.value });
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

  // From a board card: open the package, then claim it there, so the same
  // confirmations apply as on the execution page.
  const claimFromQueue = async (id: string) => {
    await open(id);
    if (current.value?.id === id) await runTransition('claim');
  };

  // Lets a pending package start before one of its dependencies is done.
  const waiveDependency = async (task: packageTypes.TaskView, dependency: packageTypes.PackageDependency) => {
    const confirmed = await confirmAction({
      title: '不等前置，直接开始？',
      body: `「${task.title}」原计划等「${dependency.title ?? dependency.id}」完成后再做，因为它可能要用到前置包写的代码。不等的话，你可能要自己补上缺的部分。`,
      accept: '解除这条依赖',
    });
    if (!confirmed) return false;
    try {
      const updated = await call(window.taskpilot.waiveDependency(task.id, dependency.id));
      useTasksStore().tasks = useTasksStore().tasks.map((entry) => (entry.id === updated.id ? updated : entry));
      if (current.value?.id === updated.id) current.value = updated;
      showToast('已解除这条依赖，可以开始执行了。');
      return true;
    } catch (error) {
      console.error(error);
      showToast(`解除依赖失败：${describeError(error)}`);
      return false;
    }
  };

  return {
    // Current package
    current,
    acceptanceOverride,
    open,
    adoptTask,
    close,
    reloadCurrent,
    // Queue actions
    claimFromQueue,
    waiveDependency,
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
    diffFile,
    // Verification
    verifyKind,
    verifyRunning,
    verifyResult,
    verifyError,
    runVerification,
    // Transitions
    transitioning,
    runTransition,
    // Practice
    reference,
    referenceError,
    loadReference,
    regrade,
    // Claim dialog
    claimOpen,
    claimMode,
    closeClaim,
    confirmClaim,
    // Modals
    deviationOpen,
    deviationForm,
    openDeviationForm,
    closeDeviationForm,
    submitDeviation,
  };
});
