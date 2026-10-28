// The work package open in the execution view: its state, the diff against
// the baseline, verification runs, and the deviation form. Background work
// is refreshed by repository-scoped state events.
import { defineStore } from 'pinia';
import { ref } from 'vue';

import { call } from '@/lib/ipc.ts';
import { describeError, describeErrorInfo } from '@/lib/errors.ts';
import type { IconName } from '@/lib/icons.ts';
import { announceAgent, showToast } from '@/lib/feedback.ts';
import { createExecutionActions } from './execution_actions.ts';
import type * as envelopeTypes from '@shared/ipc/envelope.ts';
import type * as packageTypes from '@shared/ipc/packages.ts';
import type * as workspaceTypes from '@shared/ipc/workspace.ts';
import { useAppStore } from './app.ts';
import { useTasksStore } from './tasks.ts';
import { useRepositoryIdentityStore } from './repository_identity.ts';

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

const DEFAULT_VERIFY_STEPS: { id: workspaceTypes.CheckKind; label: string | null }[] = [
  { id: 'test', label: null },
  { id: 'lint', label: null },
  { id: 'build', label: null },
];

export const useExecutionStore = defineStore('execution', () => {
  // ========== Current package ==========
  const current = ref<packageTypes.TaskView | null>(null);
  // Acceptance evidence from the last verification run; falls back to the review's.
  const acceptanceOverride = ref<workspaceTypes.CriterionEvidence[] | null>(null);
  let generation = 0;
  let unsubscribe: (() => void) | null = null;
  let reading = false;
  let queued = false;
  // Re-reads the open package and the queue after a state change.
  const reloadCurrent = async () => {
    const before = current.value;
    const token = generation;
    if (!before) return;
    const fresh = await call(window.taskpilot.tasks.get(before.id));
    if (generation !== token || current.value?.id !== before.id) return;
    current.value = fresh;
    acceptanceOverride.value = null;
    await refreshDiff();
    await useTasksStore().reloadQueue();
  };

  const open = async (id: string) => {
    const token = ++generation;
    let task: packageTypes.TaskView;
    try {
      task = await call(window.taskpilot.tasks.get(id));
    } catch (error) {
      console.error(error);
      showToast(`打开工作包失败：${describeError(error)}`);
      return;
    }
    if (generation !== token || !(await useAppStore().navigate('execution'))) return;
    unsubscribe?.();
    current.value = task;
    acceptanceOverride.value = null;
    diff.value = null;
    diffHint.value = '相对领取时的基线';
    verifyKind.value = null;
    verifyRunning.value = false;
    verifyResult.value = null;
    verifyError.value = null;
    actions.deviationOpen.value = false;
    startWatching();
    await Promise.all([refreshDiff(), loadVerifySteps()]);
  };

  const close = () => {
    generation += 1;
    unsubscribe?.();
    unsubscribe = null;
    current.value = null;
    actions.deviationOpen.value = false;
  };

  // Replace the open task after a coding or other background IPC action. The
  // queue entry is updated in place so the sidebar never lags behind the view.
  const adoptTask = (task: packageTypes.TaskView) => {
    if (current.value?.id !== task.id) return false;
    current.value = task;
    useTasksStore().tasks = useTasksStore().tasks.map((entry) => (entry.id === task.id ? task : entry));
    return true;
  };

  const actions = createExecutionActions({ current, reloadCurrent, open, adoptTask });

  // ========== Steps ==========
  const setStepDone = async (stepIndex: number, done: boolean) => {
    if (!current.value) return false;
    const id = current.value.id;
    try {
      const state = await call(window.taskpilot.packages.setStepDone(id, stepIndex, done));
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
  const remeasureBaseline = async () => {
    if (!current.value) return;
    try {
      const task = await call(window.taskpilot.packages.measureBaseline(current.value.id));
      const measuring: workspaceTypes.BaselineChecks = {
        status: 'measuring',
        reason: null,
        commit: task.baseline ?? '',
        checks: {},
        startedAt: new Date().toISOString(),
        finishedAt: null,
      };
      current.value = { ...task, baselineChecks: measuring };
    } catch (error) {
      console.error(error);
      showToast(`无法重新测量：${describeError(error)}`, 'error');
    }
  };

  // ========== Review and adjudication ==========

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

  const refreshBackground = async () => {
    const before = current.value;
    const token = generation;
    if (!before) return;
    if (reading) {
      queued = true;
      return;
    }
    reading = true;
    try {
      const task = await call(window.taskpilot.tasks.get(before.id));
      if (generation !== token || current.value?.id !== before.id) return;
      current.value = task;
      acceptanceOverride.value = null;
      await refreshDiff();
      await useTasksStore().reloadQueue();
      if (before.review?.status === 'running' && task.review?.status !== 'running') announceReview(task);
      if (before.grade && before.grade.status !== 'done' && task.grade?.status === 'done') announceAgent('导师判完卷了，参考答案也可以看了。');
      if (before.adjudication?.status === 'running' && task.adjudication?.status !== 'running') announceAdjudication(task);
    } catch (error) {
      console.error('[execution] state refresh failed', error);
    } finally {
      reading = false;
      if (queued) {
        queued = false;
        refreshBackground().catch((error) => console.error(error));
      }
    }
  };

  const startWatching = () => {
    unsubscribe?.();
    const repositories = useRepositoryIdentityStore();
    unsubscribe = window.taskpilot.state.onChanged((change) => {
      if (change.repositoryId !== repositories.currentId) return;
      if (change.domains.some((domain) => domain === 'packages' || domain === 'workspace')) refreshBackground().catch((error) => console.error(error));
    });
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
  // The steps that run in this repository, for the verify buttons; the
  // fixed ones until the workspace answers.
  const verifySteps = ref<{ id: workspaceTypes.CheckKind; label: string | null }[]>(DEFAULT_VERIFY_STEPS);
  const loadVerifySteps = async () => {
    try {
      const view = await call(window.taskpilot.workspace.get());
      verifySteps.value = view.steps.filter((step) => step.effective && step.id !== 'setup').map((step) => ({ id: step.id, label: step.label }));
    } catch (error) {
      console.error(error);
      verifySteps.value = DEFAULT_VERIFY_STEPS;
    }
  };
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

  // Explaining the differences from the reference: Tutor picks them, the
  // developer answers each (null skips one), then it is saved as a note.
  const explaining = ref(false);

  const explain = async (action: () => Promise<envelopeTypes.IpcResult<packageTypes.TaskView>>, failure: string) => {
    if (!current.value) return;
    explaining.value = true;
    try {
      adoptTask(await call(action()));
    } catch (error) {
      console.error(error);
      showToast(`${failure}：${describeError(error)}`);
    } finally {
      explaining.value = false;
    }
  };

  const startExplanation = () => explain(() => window.taskpilot.practice.explain(current.value!.id), '没能开始');
  const answerExplanation = (answers: (string | null)[]) => explain(() => window.taskpilot.practice.answer(current.value!.id, answers), '没能提交');
  const saveExplanation = async () => {
    await explain(() => window.taskpilot.practice.saveExplanation(current.value!.id), '没能存成笔记');
    if (current.value?.grade?.explanation?.noteId) showToast('已存到学习笔记。');
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
    claimFromQueue: actions.claimFromQueue,
    waiveDependency: actions.waiveDependency,
    // Steps
    setStepDone,
    // Baseline
    remeasureBaseline,
    // Review and adjudication
    runReviewAction: actions.runReviewAction,
    runDeviationAction: actions.runDeviationAction,
    // Diff
    diff,
    diffHint,
    diffVersion,
    refreshDiff,
    diffFile,
    // Verification
    verifySteps,
    loadVerifySteps,
    verifyKind,
    verifyRunning,
    verifyResult,
    verifyError,
    runVerification,
    // Transitions
    transitioning: actions.transitioning,
    runTransition: actions.runTransition,
    // Practice
    reference,
    referenceError,
    loadReference,
    regrade,
    explaining,
    startExplanation,
    answerExplanation,
    saveExplanation,
    // Claim dialog
    claimOpen: actions.claimOpen,
    claimMode: actions.claimMode,
    closeClaim: actions.closeClaim,
    confirmClaim: actions.confirmClaim,
    // Modals
    deviationOpen: actions.deviationOpen,
    deviationForm: actions.deviationForm,
    openDeviationForm: actions.openDeviationForm,
    closeDeviationForm: actions.closeDeviationForm,
    submitDeviation: actions.submitDeviation,
  };
});
