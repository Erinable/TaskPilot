// Requirement center: write a requirement, answer Product Lead's questions,
// review the proposed work packages, and publish them to the queue. A course
// requirement ("我想学…") runs Tutor's goal interview instead and ends with
// a learning path, or a drafted course pack to edit and confirm first.
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import { call } from '@/lib/ipc.ts';
import type { IpcError } from '@/lib/ipc.ts';
import { describeError, describeErrorInfo } from '@/lib/errors.ts';
import { announceAgent, confirmAction, showToast } from '@/lib/feedback.ts';
import * as model from '@/components/requirements/requirement_model.ts';
import { createRequirementsCourseActions } from './requirements_course.ts';
import { useAppStore } from './app.ts';
import { useTasksStore } from './tasks.ts';
import { useRepositoryIdentityStore } from './repository_identity.ts';
import { createStateWatcher } from './state_watcher.ts';
import type * as requirementTypes from '@shared/ipc/requirements.ts';
import type * as workspaceTypes from '@shared/ipc/workspace.ts';
import type { GoalForm } from '@shared/course_plan.ts';

export type RequirementPane = 'new' | 'detail' | 'empty';

// What the compose form tells the user up front about what agents will see.
export type ComposeContext = { workspace: workspaceTypes.WorkspaceInfo; agentAvailable: boolean };

export const useRequirementsStore = defineStore('requirements', () => {
  // ========== List ==========
  const items = ref<requirementTypes.Requirement[]>([]);
  // Requirements waiting on the human, for the sidebar badge.
  const attentionCount = computed(() => items.value.filter(model.needsAttention).length);

  const refreshList = async () => {
    const token = watcher.session();
    try {
      const next = await call(window.taskpilot.requirements.list());
      if (token === watcher.session()) items.value = next;
    } catch (error) {
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
  // The requirement detail pane keeps a snapshot so state events never
  // disturb answers being typed.
  const current = ref<requirementTypes.Requirement | null>(null);
  // Bumped on every detail render; the pane is keyed on it to reset its inputs.
  const detailRevision = ref(0);

  const renderDetail = (item: requirementTypes.Requirement) => {
    if (selectedId.value !== item.id) return;
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
    const token = contextGeneration;
    const repositoryId = useRepositoryIdentityStore().currentId;
    try {
      const course = composeKind.value === 'course' ? { course: { ...composeForm.value } } : {};
      const item = await call(window.taskpilot.requirements.create({ title: composeTitle.value, text, ...course }));
      if (repositoryId !== useRepositoryIdentityStore().currentId) return;
      upsert(item);
      if (token !== contextGeneration || !composing.value) return;
      composeTitle.value = '';
      composeText.value = '';
      composing.value = false;
      contextGeneration += 1;
      selectedId.value = item.id;
      renderDetail(item);
      startWatching();
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
    const token = watcher.session();
    try {
      // A project's plan request carries no choice argument at all.
      const planned = () => (choice ? window.taskpilot.requirements.plan(item.id, answers, choice) : window.taskpilot.requirements.plan(item.id, answers));
      const next = await call(step === 'plan' ? planned() : window.taskpilot.requirements.clarify(item.id));
      if (token !== watcher.session()) return;
      upsert(next);
      renderDetail(next);
      startWatching();
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
    const token = watcher.session();
    try {
      const next = await call(
        window.taskpilot.requirements.answer(
          item.id,
          item.questions.map((question) => question.answer ?? ''),
        ),
      );
      if (token !== watcher.session()) return;
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
    const token = watcher.session();
    try {
      const next = await call(window.taskpilot.requirements.publish(item.id));
      if (token !== watcher.session()) return false;
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
    const token = watcher.session();
    try {
      await call(window.taskpilot.requirements.remove(item.id));
      if (token !== watcher.session()) return;
      await refreshList();
      if (selectedId.value === item.id) {
        selectedId.value = null;
        current.value = null;
        pane.value = 'empty';
      }
      showToast('需求已删除。');
    } catch (error) {
      console.error(error);
      showToast(`删除失败：${describeError(error)}`);
    }
  };

  const showQueue = () => useAppStore().navigate('queue');

  // ========== State events ==========
  const announceLab = (lab: requirementTypes.LabGeneration) => {
    if (lab.status === 'ready') announceAgent(`lab「${lab.lab?.title ?? ''}」生成好了，自验证已通过。`, 'info');
    else if (lab.status === 'needs_review') announceAgent(`lab「${lab.lab?.title ?? ''}」自验证没有通过，等你决定怎么办。`);
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

  const stateKey = (item: requirementTypes.Requirement) =>
    `${item.status}:${item.phase ?? ''}:${item.course?.lab ? `${item.course.lab.status}:${item.course.lab.phase ?? ''}` : ''}`;
  const watcher = createStateWatcher({
    name: 'requirements',
    domains: ['requirements'],
    read: async (isCurrent) => {
      const before = new Map(items.value.map((item) => [item.id, stateKey(item)]));
      await refreshList();
      if (!isCurrent()) return;
      const open = items.value.find((item) => item.id === selectedId.value);
      if (open && !composing.value && useAppStore().view === 'requirements' && before.get(open.id) !== stateKey(open)) {
        renderDetail(open);
        if (!model.isRunning(open) && open.course?.lab?.status !== 'running') announce(open);
      }
    },
  });

  const startWatching = () => {
    if (useAppStore().view !== 'requirements') return;
    watcher.start().catch((error) => console.error(error));
  };

  const stopWatching = () => watcher.stop();

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
    startWatching();
  };

  // Loads counts for the sidebar badge on startup, without opening the view.
  const init = async () => {
    await refreshList();
    // Startup only loads the badge; the view subscribes through open().
  };

  const courseActions = createRequirementsCourseActions({ upsert, renderDetail, open, startWatching, runStep, revision: () => watcher.session() });

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
    // Course path, draft and lab actions
    courseBusy: courseActions.courseBusy,
    savePath: courseActions.savePath,
    confirmPath: courseActions.confirmPath,
    saveDraft: courseActions.saveDraft,
    draftSaved: courseActions.draftSaved,
    confirmDraft: courseActions.confirmDraft,
    labEstimate: courseActions.labEstimate,
    loadLabEstimate: courseActions.loadLabEstimate,
    generateLab: courseActions.generateLab,
    addLab: courseActions.addLab,
    nextLab: courseActions.nextLab,
    // State events
    startWatching,
    stopWatching,
    // Navigation
    open,
    init,
  };
});
