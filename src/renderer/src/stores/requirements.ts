// Requirement center: write a requirement, answer Product Lead's questions,
// review the proposed work packages, and publish them to the queue.
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import { call } from '@/lib/ipc.ts';
import { describeError, describeErrorInfo } from '@/lib/errors.ts';
import { announceAgent, confirmAction, showToast } from '@/lib/feedback.ts';
import * as model from '@/components/requirements/requirement_model.ts';
import { useAppStore } from './app.ts';
import { useTasksStore } from './tasks.ts';
import type { IpcError } from '@/lib/ipc.ts';
import type * as ipc from '@shared/ipc_types.ts';

export type RequirementPane = 'new' | 'detail' | 'empty';

// What the compose form tells the user up front about what agents will see.
export type ComposeContext = { workspace: ipc.WorkspaceInfo; agentAvailable: boolean };

export const useRequirementsStore = defineStore('requirements', () => {
  // ========== List ==========
  const items = ref<ipc.Requirement[]>([]);
  // Requirements waiting on the human, for the sidebar badge.
  const attentionCount = computed(() => items.value.filter(model.needsAttention).length);

  const refreshList = async () => {
    try {
      items.value = await call(window.taskpilot.requirements.list());
    } catch (error) {
      // Keep the last list: clearing it would drop the badge and the
      // notifications' read state over one failed poll.
      console.error('Failed to load requirements', error);
    }
  };

  const upsert = (item: ipc.Requirement) => {
    const index = items.value.findIndex((candidate) => candidate.id === item.id);
    if (index === -1) items.value.unshift(item);
    else items.value[index] = item;
  };

  // ========== Selection ==========
  const pane = ref<RequirementPane | null>(null);
  const selectedId = ref<string | null>(null);
  const composing = ref(false);
  // The requirement the detail pane shows. A snapshot, replaced only when the
  // page re-renders it, so polling never disturbs answers being typed.
  const current = ref<ipc.Requirement | null>(null);
  // Bumped on every detail render; the pane is keyed on it to reset its inputs.
  const detailRevision = ref(0);

  const renderDetail = (item: ipc.Requirement) => {
    current.value = item;
    pane.value = 'detail';
    detailRevision.value += 1;
  };

  const select = (id: string) => {
    const item = items.value.find((candidate) => candidate.id === id);
    if (!item) return;
    composing.value = false;
    contextGeneration += 1;
    selectedId.value = id;
    renderDetail(item);
  };

  // ========== Compose ==========
  const composeTitle = ref('');
  const composeText = ref('');
  const composeStatus = ref<{ text: string; error: boolean }>({ text: '', error: false });
  const composeInvalid = ref(false);
  const submitting = ref(false);
  // Bumped when the form should take focus (opened, or rejected locally).
  const composeFocus = ref(0);
  const composeContext = ref<ComposeContext | null>(null);
  let contextGeneration = 0;

  const loadContext = async () => {
    const generation = ++contextGeneration;
    composeContext.value = null;
    try {
      const [workspace, agent] = await Promise.all([
        call(window.taskpilot.workspace.info()),
        call(window.taskpilot.agent.status()).catch(() => ({ available: false })),
      ]);
      if (generation === contextGeneration && composing.value) composeContext.value = { workspace, agentAvailable: agent.available };
    } catch (error) {
      if (generation === contextGeneration) console.error('Failed to read requirement context', error);
    }
  };

  const startCompose = () => {
    composing.value = true;
    selectedId.value = null;
    stopPolling();
    pane.value = 'new';
    composeStatus.value = { text: '', error: false };
    composeInvalid.value = false;
    loadContext().catch((error) => console.error(error));
    composeFocus.value += 1;
  };

  // Clears a previous "required" error once the user starts typing.
  const onComposeInput = () => {
    if (composeStatus.value.error && composeText.value.trim()) {
      composeStatus.value = { text: '', error: false };
      composeInvalid.value = false;
    }
  };

  const submitNew = async () => {
    const text = composeText.value;
    const invalid = model.validateText(text);
    composeStatus.value = { text: invalid ?? '', error: Boolean(invalid) };
    composeInvalid.value = Boolean(invalid);
    if (invalid) {
      composeFocus.value += 1;
      return;
    }
    submitting.value = true;
    try {
      const item = await call(window.taskpilot.requirements.create({ title: composeTitle.value, text }));
      composeTitle.value = '';
      composeText.value = '';
      composing.value = false;
      contextGeneration += 1;
      selectedId.value = item.id;
      upsert(item);
      renderDetail(item);
      startPolling();
    } catch (error) {
      if ((error as IpcError).field === 'text') composeStatus.value = { text: describeError(error), error: true };
      else {
        console.error(error);
        showToast(`提交失败：${describeError(error)}`);
      }
    } finally {
      submitting.value = false;
    }
  };

  // ========== Actions ==========
  // The step request in flight, until the requirement reports it is running.
  const acting = ref<'clarify' | 'plan' | 'edit' | null>(null);

  const runStep = async (item: ipc.Requirement, step: 'clarify' | 'plan', answers?: ipc.RequirementAnswers) => {
    if (acting.value) return;
    acting.value = step;
    try {
      const next =
        step === 'plan' ? await call(window.taskpilot.requirements.plan(item.id, answers)) : await call(window.taskpilot.requirements.clarify(item.id));
      upsert(next);
      renderDetail(next);
      startPolling();
    } catch (error) {
      console.error(error);
      showToast(`操作失败：${describeError(error)}`);
    } finally {
      acting.value = null;
    }
  };

  // Back to the question form with the current answers, discarding the plan.
  const editAnswers = async (item: ipc.Requirement) => {
    if (acting.value) return;
    acting.value = 'edit';
    try {
      const next = await call(
        window.taskpilot.requirements.answer(
          item.id,
          item.questions.map((question) => question.answer ?? ''),
        ),
      );
      upsert(next);
      renderDetail(next);
    } catch (error) {
      console.error(error);
      showToast(`操作失败：${describeError(error)}`);
    } finally {
      acting.value = null;
    }
  };

  // Resolves false when publishing failed, so the button can be used again.
  const publishPlan = async (item: ipc.Requirement) => {
    try {
      const next = await call(window.taskpilot.requirements.publish(item.id));
      upsert(next);
      renderDetail(next);
      await useTasksStore().reloadQueue();
      showToast(`已发布 ${next.packages.length} 个工作包到工作队列。`);
      return true;
    } catch (error) {
      console.error(error);
      showToast(`发布失败：${describeError(error)}`);
      return false;
    }
  };

  const cancelRun = async (item: ipc.Requirement) => {
    try {
      await call(window.taskpilot.requirements.cancel(item.id));
    } catch (error) {
      console.error(error);
      showToast(`取消失败：${describeError(error)}`);
    }
  };

  const removeRequirement = async (item: ipc.Requirement) => {
    const confirmed = await confirmAction({
      title: '删除这个需求？',
      body: '需求、Product Lead 的问题和拆解结果都会被删除，无法恢复。',
      accept: '删除',
      danger: true,
    });
    if (!confirmed) return;
    try {
      await call(window.taskpilot.requirements.remove(item.id));
      selectedId.value = null;
      await refreshList();
      pane.value = 'empty';
      showToast('需求已删除。');
    } catch (error) {
      console.error(error);
      showToast(`删除失败：${describeError(error)}`);
    }
  };

  const showQueue = () => useAppStore().navigate('queue');

  // ========== Polling ==========
  let pollTimer: ReturnType<typeof setTimeout> | null = null;

  const stopPolling = () => {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
  };

  const announce = (item: ipc.Requirement) => {
    if (item.status === 'answering') announceAgent('Product Lead 提出了澄清问题，等你回答。', 'info');
    else if (item.status === 'reviewing') announceAgent('工作包拆解完成，请确认。', 'info');
    else if (item.status === 'failed' && item.error?.code !== 'agent_cancelled') announceAgent(`Product Lead 运行失败：${describeErrorInfo(item.error)}`);
  };

  // While any requirement is running, re-reads the list; re-renders the open
  // one only when its status changes, so typing in answers isn't disturbed.
  const tick = async () => {
    const before = new Map(items.value.map((item) => [item.id, model.pollKey(item)]));
    await refreshList();
    const open = items.value.find((item) => item.id === selectedId.value);
    if (open && !composing.value && useAppStore().view === 'requirements' && before.get(open.id) !== model.pollKey(open)) {
      renderDetail(open);
      if (!model.isRunning(open)) announce(open);
    }
    if (items.value.some(model.isRunning))
      pollTimer = setTimeout(() => {
        tick().catch((error) => console.error(error));
      }, model.POLL_MS);
    else pollTimer = null;
  };

  const startPolling = () => {
    stopPolling();
    pollTimer = setTimeout(() => {
      tick().catch((error) => console.error(error));
    }, model.POLL_MS);
  };

  const isPolling = () => pollTimer !== null;

  // ========== Navigation ==========
  const open = async ({ compose = false, id = null }: { compose?: boolean; id?: string | null } = {}) => {
    const app = useAppStore();
    if (!(await app.navigate('requirements'))) return;
    await refreshList();
    const target = id ?? selectedId.value;
    if (compose) startCompose();
    else if (target) select(target);
    else if (items.value.length) select(items.value[0].id);
    else pane.value = 'empty';
    if (items.value.some(model.isRunning)) startPolling();
  };

  // Loads counts for the sidebar badge on startup, without opening the view.
  const init = async () => {
    await refreshList();
    if (items.value.some(model.isRunning)) startPolling();
  };

  return {
    // List
    items,
    attentionCount,
    refreshList,
    // Selection
    pane,
    selectedId,
    composing,
    current,
    detailRevision,
    select,
    // Compose
    composeTitle,
    composeText,
    composeStatus,
    composeInvalid,
    submitting,
    composeFocus,
    composeContext,
    startCompose,
    onComposeInput,
    submitNew,
    // Actions
    acting,
    runStep,
    editAnswers,
    publishPlan,
    cancelRun,
    removeRequirement,
    showQueue,
    // Polling
    startPolling,
    stopPolling,
    isPolling,
    // Navigation
    open,
    init,
  };
});
