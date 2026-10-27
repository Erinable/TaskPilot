// Requirement center: write a requirement, answer Product Lead's questions,
// review the proposed work packages, and publish them to the queue. A course
// requirement ("我想学…") runs Tutor's goal interview instead and ends with
// a learning path, or a drafted course pack to edit and confirm first.
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import { IpcError, call } from '@/lib/ipc.ts';
import { describeError, describeErrorInfo } from '@/lib/errors.ts';
import { announceAgent, confirmAction, showToast } from '@/lib/feedback.ts';
import * as model from '@/components/requirements/requirement_model.ts';
import { useAppStore } from './app.ts';
import { useTasksStore } from './tasks.ts';
import type * as requirementTypes from '@shared/ipc/requirements.ts';
import type * as workspaceTypes from '@shared/ipc/workspace.ts';
import type { CoursePack } from '@shared/course_pack.ts';
import type { GoalForm, PathEntry } from '@shared/course_plan.ts';

export type RequirementPane = 'new' | 'detail' | 'empty';

// What the compose form tells the user up front about what agents will see.
export type ComposeContext = { workspace: workspaceTypes.WorkspaceInfo; agentAvailable: boolean };

export const useRequirementsStore = defineStore('requirements', () => {
  // ========== List ==========
  const items = ref<requirementTypes.Requirement[]>([]);
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

  const upsert = (item: requirementTypes.Requirement) => {
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
  const current = ref<requirementTypes.Requirement | null>(null);
  // Bumped on every detail render; the pane is keyed on it to reset its inputs.
  const detailRevision = ref(0);

  const renderDetail = (item: requirementTypes.Requirement) => {
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
  // What the form asks for: work on the repository, or something to learn.
  const composeKind = ref<requirementTypes.RequirementKind>('project');
  const composeForm = ref<GoalForm>({ level: 'basic', target: 'implement', environment: model.ENVIRONMENT_OPTIONS[0], weeklyHours: 4 });
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

  const startCompose = (kind: requirementTypes.RequirementKind = 'project') => {
    composeKind.value = kind;
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
      const course = composeKind.value === 'course' ? { course: { ...composeForm.value } } : {};
      const item = await call(window.taskpilot.requirements.create({ title: composeTitle.value, text, ...course }));
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

  const runStep = async (
    item: requirementTypes.Requirement,
    step: 'clarify' | 'plan',
    answers?: requirementTypes.RequirementAnswers,
    choice?: requirementTypes.CourseChoice,
  ) => {
    if (acting.value) return;
    acting.value = step;
    try {
      // A project's plan request carries no choice argument at all.
      const planned = () => (choice ? window.taskpilot.requirements.plan(item.id, answers, choice) : window.taskpilot.requirements.plan(item.id, answers));
      const next = await call(step === 'plan' ? planned() : window.taskpilot.requirements.clarify(item.id));
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
  const editAnswers = async (item: requirementTypes.Requirement) => {
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
  const publishPlan = async (item: requirementTypes.Requirement) => {
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

  const cancelRun = async (item: requirementTypes.Requirement) => {
    try {
      await call(window.taskpilot.requirements.cancel(item.id));
    } catch (error) {
      console.error(error);
      showToast(`取消失败：${describeError(error)}`);
    }
  };

  const removeRequirement = async (item: requirementTypes.Requirement) => {
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

  // ========== Course path and draft ==========
  const courseBusy = ref(false);

  const courseAction = async (action: () => Promise<requirementTypes.Requirement>, failure: string) => {
    courseBusy.value = true;
    try {
      const next = await action();
      upsert(next);
      renderDetail(next);
      return next;
    } catch (error) {
      console.error(error);
      showToast(`${failure}：${describeError(error)}`);
      return null;
    } finally {
      courseBusy.value = false;
    }
  };

  // The learner reordered the path or marked a concept.
  const savePath = (item: requirementTypes.Requirement, path: PathEntry[]) =>
    courseAction(() => call(window.taskpilot.requirements.coursePath(item.id, path)), '保存路径失败');

  const confirmPath = async (item: requirementTypes.Requirement) => {
    const next = await courseAction(() => call(window.taskpilot.requirements.publish(item.id)), '确认路径失败');
    if (next) showToast('学习路径已确认。');
  };

  // ========== First lab ==========
  // The estimate shown before generating; nothing runs until the learner confirms.
  const labEstimate = ref<{ requirementId: string; estimate: requirementTypes.LabEstimate } | null>(null);

  const loadLabEstimate = async (item: requirementTypes.Requirement) => {
    courseBusy.value = true;
    try {
      labEstimate.value = { requirementId: item.id, estimate: await call(window.taskpilot.requirements.labEstimate(item.id)) };
    } catch (error) {
      console.error(error);
      showToast(`预估费用失败：${describeError(error)}`);
    } finally {
      courseBusy.value = false;
    }
  };

  const generateLab = async (item: requirementTypes.Requirement) => {
    const next = await courseAction(() => call(window.taskpilot.requirements.labGenerate(item.id)), '生成 lab 失败');
    if (!next) return;
    labEstimate.value = null;
    startPolling();
  };

  // Saves the edited draft into the global folder. A refusal naming a field
  // is returned for the editor to show there.
  const saveDraft = async (item: requirementTypes.Requirement, pack: CoursePack) => {
    courseBusy.value = true;
    try {
      const saved = await call(window.taskpilot.requirements.courseSaveDraft(item.id, pack));
      upsert(saved.requirement);
      renderDetail(saved.requirement);
      draftSaved.value = { requirementId: item.id, ref: saved.ref, pack };
      return null;
    } catch (error) {
      console.error(error);
      if (error instanceof IpcError && error.field && error.code !== 'unknown') return { field: error.field, message: describeError(error) };
      showToast(`保存课程包失败：${describeError(error)}`);
      return null;
    } finally {
      courseBusy.value = false;
    }
  };

  // The pack just saved from the draft, shown in full to confirm.
  const draftSaved = ref<{ requirementId: string; ref: requirementTypes.CourseDraftSaved['ref']; pack: CoursePack } | null>(null);

  // Confirms the saved pack at the content shown, then plans the path with it.
  const confirmDraft = async (item: requirementTypes.Requirement) => {
    const saved = draftSaved.value;
    if (!saved || saved.requirementId !== item.id) return;
    const next = await courseAction(() => call(window.taskpilot.requirements.courseConfirmDraft(item.id, saved.ref.contentHash)), '确认课程包失败');
    if (!next) return;
    draftSaved.value = null;
    showToast(`已确认课程包「${saved.pack.title}」，开始规划学习路径。`);
    await runStep(next, 'plan');
  };

  // ========== Polling ==========
  let pollTimer: ReturnType<typeof setTimeout> | null = null;

  const stopPolling = () => {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
  };

  const announceLab = (lab: requirementTypes.LabGeneration) => {
    if (lab.status === 'ready') announceAgent(`第一个 lab「${lab.lab?.title ?? ''}」生成好了。`, 'info');
    else if (lab.status === 'failed' && lab.error?.code !== 'agent_cancelled') announceAgent(`生成 lab 失败：${describeErrorInfo(lab.error)}`);
  };

  const announce = (item: requirementTypes.Requirement) => {
    if (model.isCourse(item)) {
      if (item.course?.lab && item.status === 'published') return announceLab(item.course.lab);
      if (item.status === 'answering') announceAgent('Tutor 看完了你的目标，等你选课程包。', 'info');
      else if (item.status === 'reviewing')
        announceAgent(item.course?.draft ? 'Tutor 起草了一个课程包，等你预览和确认。' : '学习路径规划好了，请确认。', 'info');
      else if (item.status === 'failed' && item.error?.code !== 'agent_cancelled') announceAgent(`Tutor 运行失败：${describeErrorInfo(item.error)}`);
      return;
    }
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
      if (!model.isRunning(open) && !model.labRunning(open)) announce(open);
    }
    if (model.anyPolled(items.value))
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
  // `compose: 'course'` opens the "我想学…" form.
  const open = async ({ compose = false, id = null }: { compose?: boolean | requirementTypes.RequirementKind; id?: string | null } = {}) => {
    const app = useAppStore();
    if (!(await app.navigate('requirements'))) return;
    await refreshList();
    const target = id ?? selectedId.value;
    if (compose) startCompose(compose === true ? 'project' : compose);
    else if (target) select(target);
    else if (items.value.length) select(items.value[0].id);
    else pane.value = 'empty';
    if (model.anyPolled(items.value)) startPolling();
  };

  // Loads counts for the sidebar badge on startup, without opening the view.
  const init = async () => {
    await refreshList();
    if (model.anyPolled(items.value)) startPolling();
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
    composeKind,
    composeForm,
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
    // Course path and draft
    courseBusy,
    savePath,
    confirmPath,
    saveDraft,
    draftSaved,
    confirmDraft,
    // First lab
    labEstimate,
    loadLabEstimate,
    generateLab,
    // Polling
    startPolling,
    stopPolling,
    isPolling,
    // Navigation
    open,
    init,
  };
});
