import { computed, ref } from 'vue';
import { defineStore } from 'pinia';

import { call } from '@/lib/ipc.ts';
import { confirmAction, showToast } from '@/lib/feedback.ts';
import { describeError } from '@/lib/errors.ts';
import type * as ipc from '@shared/ipc_types.ts';
import { useExecutionStore } from './execution.ts';

export const CODING_POLL_MS = 1000;
export const CODING_SETUP_SCRIPT = 'scripts/setup-coding-agent-user.sh';

const ACTIVE_STATUSES: ipc.CodingRun['status'][] = ['preparing', 'running', 'checking', 'applying'];
const TERMINAL_STATUSES: ipc.CodingRun['status'][] = ['ready', 'applied', 'failed', 'cancelled', 'discarded'];

export const useCodingStore = defineStore('coding', () => {
  const execution = useExecutionStore();
  const runtime = ref<ipc.CodingRuntimeStatus | null>(null);
  const runtimeLoading = ref(false);
  const runtimeError = ref<string | null>(null);
  const events = ref<ipc.CodingEvent[]>([]);
  const eventCursor = ref(-1);
  const eventsLoading = ref(false);
  const patch = ref<ipc.CodingPatchPreview | null>(null);
  const patchLoading = ref(false);
  const operation = ref<'status' | 'start' | 'cancel' | 'retry' | 'apply' | null>(null);
  const error = ref<string | null>(null);
  const instruction = ref('');
  const selectedId = ref<string | null>(null);
  let generation = 0;
  let runtimeGeneration = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const run = computed(() => execution.current?.codingRun ?? null);
  const eligible = computed(() => execution.current?.status === 'in_progress' || !!run.value);
  const active = computed(() => {
    const codingRun = run.value;
    return codingRun ? ACTIVE_STATUSES.includes(codingRun.status) : false;
  });
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
  const highRisk = computed(() => patch.value?.files.some((file) => file.highRisk) ?? run.value?.files.some((file) => file.highRisk) ?? false);
  const hasBlocked = computed(() => (patch.value?.blocked.length ?? run.value?.blocked.length ?? 0) > 0);

  const stopPolling = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const sameSelection = (id: string, token: number) => selectedId.value === id && generation === token && execution.current?.id === id;

  const adopt = (task: ipc.TaskView, id: string, token: number) => {
    if (!sameSelection(id, token)) return false;
    execution.adoptTask(task);
    return true;
  };

  const loadPatch = async (id: string, token = generation) => {
    patchLoading.value = true;
    try {
      const value = await call(window.taskpilot.coding.patch(id));
      if (sameSelection(id, token)) patch.value = value;
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
      if (task.codingRun?.status === 'ready' && !patch.value) await loadPatch(id, token);
      if (task.codingRun && ACTIVE_STATUSES.includes(task.codingRun.status)) {
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
    patchLoading.value = false;
    error.value = null;
    operation.value = null;
    instruction.value = '';
    await refreshRuntime();
    if (!sameSelection(id, token)) return;
    try {
      const task = await call(window.taskpilot.coding.get(id));
      if (!adopt(task, id, token)) return;
      instruction.value = task.codingRun?.instruction ?? '';
      if (task.codingRun && ACTIVE_STATUSES.includes(task.codingRun.status)) startPolling(id, token);
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
      stopPolling();
      return true;
    } catch (cause) {
      if (sameSelection(id, token)) error.value = `取消编码失败：${describeError(cause)}`;
      return false;
    } finally {
      operation.value = null;
    }
  };

  const apply = async (allowHighRisk: boolean) => {
    const id = selectedId.value;
    const digest = patch.value?.digest ?? run.value?.patchDigest;
    if (!id || !digest || operation.value || run.value?.status !== 'ready' || hasBlocked.value) return false;
    if (highRisk.value && !allowHighRisk) return false;
    const confirmed = await confirmAction({
      title: highRisk.value ? '应用编码改动？（含高风险文件）' : '应用编码改动？',
      body: highRisk.value
        ? '这会把编码 Agent 的补丁写入工作区。你已明确同意应用标记为高风险的项目控制或测试文件；请先检查原始 diff。'
        : '这会把编码 Agent 的补丁写入工作区。应用不会自动提交 QA，请确认你已检查文件范围和原始 diff。',
      accept: highRisk.value ? '同意高风险并应用' : '应用改动',
      danger: highRisk.value,
    });
    if (!confirmed) return false;
    operation.value = 'apply';
    const token = generation;
    try {
      const result = await call(window.taskpilot.coding.apply(id, { digest, allowHighRisk }));
      const task = await call(window.taskpilot.coding.get(id));
      if (!adopt(task, id, token)) return false;
      await execution.refreshDiff();
      if (!sameSelection(id, token)) return false;
      patch.value = null;
      stopPolling();
      showToast(`已应用 ${result.files.length} 个文件；请人工验证并提交审查。`);
      return true;
    } catch (cause) {
      if (sameSelection(id, token)) error.value = `应用编码改动失败：${describeError(cause)}`;
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
    terminal,
    highRisk,
    hasBlocked,
    select,
    leave,
    refreshRuntime,
    start,
    cancel,
    apply,
    setupScript: CODING_SETUP_SCRIPT,
  };
});
