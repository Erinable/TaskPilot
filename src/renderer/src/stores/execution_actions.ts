import { ref, type Ref } from 'vue';

import { call } from '@/lib/ipc.ts';
import { describeError } from '@/lib/errors.ts';
import { defaultMode } from '@/lib/execution_mode.ts';
import { confirmAction, showToast } from '@/lib/feedback.ts';
import type { ConfirmOptions } from '@/lib/feedback.ts';
import { useAppStore } from './app.ts';
import { useTasksStore } from './tasks.ts';
import type * as packageTypes from '@shared/ipc/packages.ts';

const TRANSITION_TOASTS: Partial<Record<packageTypes.HumanTransition, string>> = {
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

const TRANSITION_CONFIRMS: Partial<Record<packageTypes.HumanTransition, ConfirmOptions>> = {
  acceptance_rejected: { title: '打回这个工作包？', body: '工作包会回到执行中，你需要修改后重新提交审查。', accept: '打回', danger: true },
  revert_replan: { title: '撤销重新规划？', body: '恢复 Architect 修订前的计划和执行进度，偏差记录会保留。', accept: '撤销' },
};

export type DeviationForm = { note: string; stepIndex: number | null; filePath: string | null };

type ExecutionActionDeps = {
  current: Ref<packageTypes.TaskView | null>;
  reloadCurrent: () => Promise<void>;
  open: (id: string) => Promise<void>;
  adoptTask: (task: packageTypes.TaskView) => boolean;
};

export const createExecutionActions = (deps: ExecutionActionDeps) => {
  const transitioning = ref<packageTypes.HumanTransition | null>(null);
  const claimOpen = ref(false);
  const claimMode = ref<packageTypes.ExecutionMode>('self');
  const deviationOpen = ref(false);
  const deviationForm = ref<DeviationForm>({ note: '', stepIndex: null, filePath: null });

  const runReviewAction = async (action: 'cancel' | 'retry') => {
    if (!deps.current.value) return;
    try {
      if (action === 'cancel') await call(window.taskpilot.review.cancel(deps.current.value.id));
      else await call(window.taskpilot.review.retry(deps.current.value.id));
      await deps.reloadCurrent();
    } catch (error) {
      console.error(error);
      showToast(`操作失败：${describeError(error)}`);
    }
  };

  const runDeviationAction = async (action: 'cancel' | 'retry') => {
    if (!deps.current.value) return;
    try {
      if (action === 'cancel') await call(window.taskpilot.deviation.cancel(deps.current.value.id));
      else await call(window.taskpilot.deviation.retry(deps.current.value.id));
      await deps.reloadCurrent();
    } catch (error) {
      console.error(error);
      showToast(`操作失败：${describeError(error)}`);
    }
  };

  const sendTransition = async (name: packageTypes.HumanTransition, options?: packageTypes.TransitionOptions) => {
    if (!deps.current.value) return;
    transitioning.value = name;
    try {
      await call(
        options
          ? window.taskpilot.packages.transition(deps.current.value.id, name, options)
          : window.taskpilot.packages.transition(deps.current.value.id, name),
      );
      await deps.reloadCurrent();
      showToast(TRANSITION_TOASTS[name] ?? '状态已更新。');
    } catch (error) {
      console.error(error);
      showToast(`操作失败：${describeError(error)}`);
    } finally {
      transitioning.value = null;
    }
  };

  const confirmDirtyClaim = async () => {
    const info = await useAppStore().refreshWorkspaceStatus();
    if (!info?.configured || !info.dirty) return true;
    return confirmAction({
      title: '项目里还有没提交的改动',
      body: `有 ${info.changedFiles} 个文件改过但还没提交。建议先把它们提交（上一个工作包完成后可以在「保存到 git」里提交），或者还原。现在开始也可以，但 TaskPilot 分不清哪些问题是这次引入的。`,
      accept: '仍然开始',
    });
  };

  const confirmBusyClaim = async (id: string) => {
    const others = useTasksStore().tasks.filter((task) => task.status === 'in_progress' && task.id !== id);
    if (!others.length) return true;
    return confirmAction({
      title: `已经有 ${others.length} 个工作包在执行中`,
      body: `「${others[0].title}」${others.length > 1 ? ` 等 ${others.length} 个` : ''}还没做完。同时做几个包时，改动容易混在一起，QA 也分不清哪些属于哪个包。建议先做完或放回队列，再开始新的。`,
      accept: '仍然开始',
    });
  };

  const openDeviationForm = () => {
    deviationForm.value = { note: '', stepIndex: null, filePath: null };
    deviationOpen.value = true;
  };
  const closeDeviationForm = () => {
    deviationOpen.value = false;
  };
  const closeClaim = () => {
    claimOpen.value = false;
  };

  const runTransition = async (name: packageTypes.HumanTransition) => {
    if (!deps.current.value || transitioning.value) return;
    if (name === 'report_deviation') {
      openDeviationForm();
      return;
    }
    const confirm = TRANSITION_CONFIRMS[name];
    if (confirm && !(await confirmAction(confirm))) return;
    if (name === 'claim') {
      if (!(await confirmBusyClaim(deps.current.value.id)) || !(await confirmDirtyClaim())) return;
      claimMode.value = defaultMode(deps.current.value);
      claimOpen.value = true;
      return;
    }
    if (name === 'submit_for_review' && deps.current.value.codingRun?.status === 'applied') {
      const proceed = await confirmAction({
        title: '确认提交审查？',
        body: '编码 Agent 的改动已写入工作区。验证和 QA 将以当前主机用户权限执行，请先确认文件范围和命令风险。',
        accept: '仍然提交审查',
      });
      if (!proceed) return;
    }
    await sendTransition(name);
  };

  const confirmClaim = async () => {
    claimOpen.value = false;
    await sendTransition('claim', { mode: claimMode.value });
  };

  const submitDeviation = async () => {
    if (!deps.current.value) return false;
    const { note, stepIndex, filePath } = deviationForm.value;
    if (!note.trim()) {
      showToast('请填写偏差说明。');
      return false;
    }
    try {
      await call(window.taskpilot.packages.transition(deps.current.value.id, 'report_deviation', { deviation: { note, stepIndex, filePath } }));
      closeDeviationForm();
      await deps.reloadCurrent();
      showToast('偏差已记录，Architect 正在裁决。');
    } catch (error) {
      console.error(error);
      showToast(`提交失败：${describeError(error)}`);
    }
    return true;
  };

  const claimFromQueue = async (id: string) => {
    await deps.open(id);
    if (deps.current.value?.id === id) await runTransition('claim');
  };

  const waiveDependency = async (task: packageTypes.TaskView, dependency: packageTypes.PackageDependency) => {
    const confirmed = await confirmAction({
      title: '不等前置，直接开始？',
      body: `「${task.title}」原计划等「${dependency.title ?? dependency.id}」完成后再做，因为它可能要用到前置包写的代码。不等的话，你可能要自己补上缺的部分。`,
      accept: '解除这条依赖',
    });
    if (!confirmed) return false;
    try {
      const updated = await call(window.taskpilot.packages.waiveDependency(task.id, dependency.id));
      useTasksStore().tasks = useTasksStore().tasks.map((entry) => (entry.id === updated.id ? updated : entry));
      if (deps.current.value?.id === updated.id) deps.current.value = updated;
      showToast('已解除这条依赖，可以开始执行了。');
      return true;
    } catch (error) {
      console.error(error);
      showToast(`解除依赖失败：${describeError(error)}`);
      return false;
    }
  };

  return {
    transitioning,
    runReviewAction,
    runDeviationAction,
    runTransition,
    claimFromQueue,
    waiveDependency,
    claimOpen,
    claimMode,
    closeClaim,
    confirmClaim,
    deviationOpen,
    deviationForm,
    openDeviationForm,
    closeDeviationForm,
    submitDeviation,
  };
};
