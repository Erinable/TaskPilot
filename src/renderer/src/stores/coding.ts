import { computed, ref } from 'vue';
import { defineStore } from 'pinia';

import { call } from '@/lib/ipc.ts';
import { confirmAction, showToast } from '@/lib/feedback.ts';
import { describeError } from '@/lib/errors.ts';
import { MAX_AUTO_ATTEMPTS } from '@shared/coding_types.ts';
import type * as codingTypes from '@shared/coding_types.ts';
import type * as packageTypes from '@shared/ipc/packages.ts';
import { useExecutionStore } from './execution.ts';

export const CODING_POLL_MS = 1000;
export const CODING_SETUP_SCRIPT = 'scripts/setup-coding-agent-user.sh';

const ACTIVE_STATUSES: codingTypes.CodingRun['status'][] = ['preparing', 'running', 'checking', 'applying', 'verifying'];
// The package's own steps, scope and acceptance criteria go into every prompt,
// so a first round needs no retyping; the developer can add to it.
export const DEFAULT_INSTRUCTION = '按工作包的执行指令完成全部步骤，满足验收条件，只改文件范围内的文件。';
const TERMINAL_STATUSES: codingTypes.CodingRun['status'][] = ['ready', 'applied', 'submitted', 'failed', 'cancelled', 'discarded'];

// The loop is still moving on its own: a round is working, an automatic
// round's patch is about to be applied, or QA is reviewing its submission.
export const looping = (task: packageTypes.TaskView) => {
  const codingRun = task.codingRun;
  if (!codingRun || codingRun.halt) return false;
  if (ACTIVE_STATUSES.includes(codingRun.status)) return true;
  if (codingRun.status === 'ready') return codingRun.trigger !== 'human';
  if (codingRun.status !== 'submitted') return false;
  // A rejection with attempts left is about to start the next round.
  const retrying = task.review?.status === 'rejected' && codingRun.attempt - 1 < MAX_AUTO_ATTEMPTS;
  return task.status === 'in_review' || task.review?.status === 'running' || retrying;
};

export const useCodingStore = defineStore('coding', () => {
  const execution = useExecutionStore();
  const runtime = ref<codingTypes.CodingRuntimeStatus | null>(null);
  const runtimeLoading = ref(false);
  const runtimeError = ref<string | null>(null);
  const events = ref<codingTypes.CodingEvent[]>([]);
  const eventCursor = ref(-1);
  const eventsLoading = ref(false);
  const patch = ref<codingTypes.CodingPatchPreview | null>(null);
  const patchLoading = ref(false);
  const operation = ref<'status' | 'start' | 'cancel' | 'retry' | 'apply' | null>(null);
  const error = ref<string | null>(null);
  const instruction = ref('');
  const selectedId = ref<string | null>(null);
  let generation = 0;
  let runtimeGeneration = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // The round whose events and patch are shown.
  let roundId: string | null = null;
  // Patch paths the developer accepts; all applicable files by default.
  const selectedFiles = ref<string[]>([]);
  // The developer's choice for each conflicted file.
  const resolutions = ref<Partial<Record<string, codingTypes.CodingResolution>>>({});

  const run = computed(() => execution.current?.codingRun ?? null);
  const eligible = computed(() => execution.current?.status === 'in_progress' || !!run.value);
  const active = computed(() => {
    const codingRun = run.value;
    return codingRun ? ACTIVE_STATUSES.includes(codingRun.status) : false;
  });
  const canStart = computed(() => !!runtime.value?.available && !active.value && !!instruction.value.trim() && !operation.value && eligible.value);
  const refreshRuntime = async () => {
    const token = ++runtimeGeneration;
    runtimeLoading.value = true;
    runtimeError.value = null;
    try {
      const status = await call(window.taskpilot.coding.status());
      if (runtimeGeneration === token) runtime.value = status;
    } catch (cause) {
      if (runtimeGeneration === token) runtimeError.value = describeError(cause);
    } finally {
      if (runtimeGeneration === token) runtimeLoading.value = false;
    }
  };
  const terminal = computed(() => {
    const codingRun = run.value;
    return codingRun ? TERMINAL_STATUSES.includes(codingRun.status) : false;
  });
  const loopActive = computed(() => (execution.current ? looping(execution.current) : false));
  const blockedPaths = computed(() => new Set((patch.value?.blocked ?? run.value?.blocked ?? []).map((entry) => entry.path)));
  // High-risk files are applicable with consent; other blocked files never are.
  const applicable = (file: codingTypes.CodingPatchFile) =>
    !(patch.value?.blocked ?? []).some((entry) => entry.path === file.path && entry.reason !== 'high-risk project control or test path');
  const highRisk = computed(() => (patch.value?.files ?? []).some((file) => file.highRisk && selectedFiles.value.includes(file.path)));
  const mergeOf = (filePath: string) => patch.value?.merge?.find((file) => file.path === filePath) ?? null;
  // Selected conflicts still waiting for a choice.
  const unresolved = computed(() => selectedFiles.value.filter((filePath) => mergeOf(filePath)?.state === 'conflict' && !resolutions.value[filePath]));
  const conflicts = computed(() => (patch.value?.merge ?? []).filter((file) => file.state === 'conflict'));
  const hasBlocked = computed(() => blockedPaths.value.size > 0);

  const stopPolling = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const sameSelection = (id: string, token: number) => selectedId.value === id && generation === token && execution.current?.id === id;

  const adopt = (task: packageTypes.TaskView, id: string, token: number) => {
    if (!sameSelection(id, token)) return false;
    execution.adoptTask(task);
    return true;
  };

  const loadPatch = async (id: string, token = generation) => {
    patchLoading.value = true;
    try {
      const value = await call(window.taskpilot.coding.patch(id));
      if (sameSelection(id, token)) {
        patch.value = value;
        resolutions.value = {};
        // High-risk files start unticked: applying them is an explicit choice.
        selectedFiles.value = value.files.filter((file) => applicable(file) && !file.highRisk).map((file) => file.path);
      }
    } catch (cause) {
      if (sameSelection(id, token)) error.value = `读取补丁失败：${describeError(cause)}`;
    } finally {
      if (sameSelection(id, token)) patchLoading.value = false;
    }
  };

  const poll = async (id: string, token: number) => {
    if (!sameSelection(id, token)) return;
    eventsLoading.value = true;
    try {
      const page = await call(window.taskpilot.coding.events(id, eventCursor.value));
      if (!sameSelection(id, token)) return;
      if (page.events.length) {
        events.value = [...events.value, ...page.events].slice(-200);
        eventCursor.value = page.next;
      }
      const task = await call(window.taskpilot.coding.get(id));
      if (!adopt(task, id, token)) return;
      // A new automatic round restarts its event sequence and patch.
      if (task.codingRun && task.codingRun.id !== roundId) {
        roundId = task.codingRun.id;
        events.value = [];
        eventCursor.value = -1;
        patch.value = null;
      }
      if (task.codingRun?.status === 'ready' && !patch.value) await loadPatch(id, token);
      if (looping(task)) {
        timer = setTimeout(() => poll(id, token).catch(() => undefined), CODING_POLL_MS);
      }
    } catch (cause) {
      if (sameSelection(id, token)) {
        error.value = `刷新编码进度失败：${describeError(cause)}`;
        timer = setTimeout(() => poll(id, token).catch(() => undefined), CODING_POLL_MS);
      }
    } finally {
      if (sameSelection(id, token)) eventsLoading.value = false;
    }
  };

  const startPolling = (id: string, token: number) => {
    stopPolling();
    timer = setTimeout(() => poll(id, token).catch(() => undefined), 0);
  };

  // Selecting a task invalidates all in-flight responses. Leaving the view only
  // stops polling; the main-process run is intentionally left untouched.
  const select = async (id: string) => {
    stopPolling();
    const token = ++generation;
    selectedId.value = id;
    events.value = [];
    eventCursor.value = -1;
    eventsLoading.value = false;
    patch.value = null;
    selectedFiles.value = [];
    patchLoading.value = false;
    error.value = null;
    operation.value = null;
    instruction.value = '';
    await refreshRuntime();
    if (!sameSelection(id, token)) return;
    try {
      const task = await call(window.taskpilot.coding.get(id));
      if (!adopt(task, id, token)) return;
      instruction.value = task.codingRun?.instruction ?? DEFAULT_INSTRUCTION;
      roundId = task.codingRun?.id ?? null;
      if (looping(task)) startPolling(id, token);
      else if (task.codingRun?.status === 'ready') await loadPatch(id, token);
    } catch (cause) {
      if (sameSelection(id, token)) error.value = `读取编码任务失败：${describeError(cause)}`;
    }
  };

  const leave = () => {
    stopPolling();
    selectedId.value = null;
    eventsLoading.value = false;
    patchLoading.value = false;
    operation.value = null;
    generation += 1;
  };

  const start = async (text = instruction.value, retry = false) => {
    const id = selectedId.value;
    if (!id || !text.trim() || operation.value || !eligible.value) return false;
    if (runtime.value && !runtime.value.available) return false;
    operation.value = retry ? 'retry' : 'start';
    error.value = null;
    const token = generation;
    try {
      // `resume` is deliberately never sent: the renderer only supports a new
      // run/retry, and unsupported resume requests must not be silently ignored.
      const task = await call(window.taskpilot.coding.start(id, { instruction: text.trim() }));
      if (!adopt(task, id, token)) return false;
      instruction.value = text.trim();
      roundId = task.codingRun?.id ?? null;
      events.value = [];
      eventCursor.value = -1;
      patch.value = null;
      startPolling(id, token);
      return true;
    } catch (cause) {
      if (sameSelection(id, token)) error.value = `启动编码失败：${describeError(cause)}`;
      return false;
    } finally {
      operation.value = null;
    }
  };

  const cancel = async () => {
    const id = selectedId.value;
    if (!id || operation.value) return false;
    const discardingReady = run.value?.status === 'ready';
    if (discardingReady) {
      const confirmed = await confirmAction({
        title: '取消并丢弃编码结果？',
        body: '当前补丁尚未应用。取消后会删除隔离运行目录和待应用结果，不能自动恢复。',
        accept: '丢弃结果',
        danger: true,
      });
      if (!confirmed) return false;
    }
    operation.value = 'cancel';
    const token = generation;
    try {
      await call(window.taskpilot.coding.cancel(id));
      const task = await call(window.taskpilot.coding.get(id));
      if (!adopt(task, id, token)) return false;
      patch.value = null;
      // A stopped check run still writes its final state.
      if (looping(task) || task.codingRun?.status === 'verifying') startPolling(id, token);
      else stopPolling();
      return true;
    } catch (cause) {
      if (sameSelection(id, token)) error.value = `取消编码失败：${describeError(cause)}`;
      return false;
    } finally {
      operation.value = null;
    }
  };

  const toggleFile = (filePath: string, accepted: boolean) => {
    const others = selectedFiles.value.filter((selected) => selected !== filePath);
    selectedFiles.value = accepted ? [...others, filePath] : others;
  };

  const applicationDigest = computed(() => patch.value?.mergeDigest ?? patch.value?.digest ?? run.value?.patchDigest);

  const confirmPatchApplication = async (files: string[], chosen: Partial<Record<string, codingTypes.CodingResolution>>) => {
    const overwrites = Object.entries(chosen)
      .filter(([, choice]) => choice === 'theirs')
      .map(([filePath]) => filePath);
    // Taking the agent's version throws away the developer's own edits: ask on its own.
    if (overwrites.length) {
      const confirmed = await confirmAction({
        title: `用 AI 的版本覆盖 ${overwrites.length} 个文件？`,
        body: `你在这些文件里的改动会被 AI 的版本替换，不能自动恢复：${overwrites.join('、')}。`,
        accept: '覆盖我的改动',
        danger: true,
      });
      if (!confirmed) return false;
    }
    const withMarkers = Object.values(chosen).filter((choice) => choice === 'markers').length;
    const skipped = (patch.value?.files.length ?? files.length) - files.length;
    return confirmAction({
      title: highRisk.value ? `应用 ${files.length} 个文件？（含高风险文件）` : `应用 ${files.length} 个文件？`,
      body: [
        '应用后会用你的账号权限自动跑提交前检查。检查通过就由 Coding Agent 提交 QA 审查；没通过或 QA 驳回时，会把问题交回 AI 自动重试，最多 3 轮。',
        skipped > 0 ? `没勾选的 ${skipped} 个文件不会写入。` : '',
        withMarkers ? `有 ${withMarkers} 个文件会写入冲突标记，自动检查先暂停，等你在编辑器里改完再继续。` : '',
        highRisk.value ? '你勾选了高风险的项目控制或测试文件，请先检查它们的 diff。' : '',
      ]
        .filter(Boolean)
        .join(''),
      accept: highRisk.value ? '同意高风险并应用' : '应用并自动检查',
      danger: highRisk.value,
    });
  };

  const apply = async (allowHighRisk: boolean) => {
    const id = selectedId.value;
    const digest = applicationDigest.value;
    const files = [...selectedFiles.value];
    if (!id || !digest || operation.value || run.value?.status !== 'ready' || !files.length) return false;
    if (highRisk.value && !allowHighRisk) return false;
    if (unresolved.value.length) return false;
    const chosen = Object.fromEntries(Object.entries(resolutions.value).filter(([filePath]) => files.includes(filePath)));
    if (!(await confirmPatchApplication(files, chosen))) return false;
    operation.value = 'apply';
    const token = generation;
    try {
      const result = await call(window.taskpilot.coding.apply(id, { digest, allowHighRisk, files, resolutions: chosen }));
      const task = await call(window.taskpilot.coding.get(id));
      if (!adopt(task, id, token)) return false;
      await execution.refreshDiff();
      if (!sameSelection(id, token)) return false;
      patch.value = null;
      startPolling(id, token);
      showToast(
        result.markers.length
          ? `已写入 ${result.files.length} 个文件，其中 ${result.markers.length} 个有冲突标记。改完后点「冲突已解决，继续」。`
          : `已应用 ${result.files.length} 个文件，正在跑提交前检查。`,
      );
      return true;
    } catch (cause) {
      if (sameSelection(id, token)) error.value = `应用编码改动失败：${describeError(cause)}`;
      return false;
    } finally {
      operation.value = null;
    }
  };

  const setResolution = (filePath: string, choice: codingTypes.CodingResolution) => {
    resolutions.value = { ...resolutions.value, [filePath]: choice };
  };

  // Conflict markers cleared: the checks and QA go on.
  const resume = async () => {
    const id = selectedId.value;
    if (!id || operation.value) return false;
    operation.value = 'apply';
    const token = generation;
    try {
      const task = await call(window.taskpilot.coding.resume(id));
      if (!adopt(task, id, token)) return false;
      startPolling(id, token);
      showToast('冲突已解决，正在跑提交前检查。');
      return true;
    } catch (cause) {
      if (sameSelection(id, token)) error.value = `继续失败：${describeError(cause)}`;
      return false;
    } finally {
      operation.value = null;
    }
  };

  return {
    runtime,
    runtimeLoading,
    runtimeError,
    events,
    eventsLoading,
    patch,
    patchLoading,
    operation,
    error,
    instruction,
    run,
    eligible,
    active,
    canStart,
    terminal,
    loopActive,
    highRisk,
    hasBlocked,
    selectedFiles,
    applicable,
    toggleFile,
    resolutions,
    setResolution,
    mergeOf,
    unresolved,
    conflicts,
    resume,
    maxAutoAttempts: MAX_AUTO_ATTEMPTS,
    select,
    leave,
    refreshRuntime,
    start,
    cancel,
    apply,
    setupScript: computed(() => runtime.value?.setupScript ?? CODING_SETUP_SCRIPT),
  };
});
