import { ref } from 'vue';

import { IpcError, call } from '@/lib/ipc.ts';
import { describeError } from '@/lib/errors.ts';
import { showToast } from '@/lib/feedback.ts';
import { useTasksStore } from './tasks.ts';
import type * as requirementTypes from '@shared/ipc/requirements.ts';
import type { CoursePack } from '@shared/course_pack.ts';
import type { PathEntry } from '@shared/course_plan.ts';

type CourseRequirementsDeps = {
  upsert: (item: requirementTypes.Requirement) => void;
  renderDetail: (item: requirementTypes.Requirement) => void;
  open: (options: { id: string }) => Promise<void>;
  startWatching: () => void;
  runStep: (item: requirementTypes.Requirement, step: 'clarify' | 'plan') => Promise<void>;
  revision: () => number;
};

export const createRequirementsCourseActions = (deps: CourseRequirementsDeps) => {
  const courseBusy = ref(false);
  const courseAction = async (action: () => Promise<requirementTypes.Requirement>, failure: string) => {
    courseBusy.value = true;
    const token = deps.revision();
    try {
      const next = await action();
      if (token !== deps.revision()) return null;
      deps.upsert(next);
      deps.renderDetail(next);
      return next;
    } catch (error) {
      console.error(error);
      showToast(`${failure}：${describeError(error)}`);
      return null;
    } finally {
      courseBusy.value = false;
    }
  };

  const savePath = (item: requirementTypes.Requirement, path: PathEntry[]) =>
    courseAction(() => call(window.taskpilot.requirements.coursePath(item.id, path)), '保存路径失败');

  const confirmPath = async (item: requirementTypes.Requirement) => {
    const next = await courseAction(() => call(window.taskpilot.requirements.publish(item.id)), '确认路径失败');
    if (next) showToast('学习路径已确认。');
  };

  const labEstimate = ref<{ requirementId: string; conceptId: string | null; estimate: requirementTypes.LabEstimate } | null>(null);
  const loadLabEstimate = async (item: requirementTypes.Requirement, conceptId: string | null = null) => {
    courseBusy.value = true;
    const token = deps.revision();
    try {
      const estimate = await call(window.taskpilot.requirements.labEstimate(item.id, conceptId ?? undefined));
      if (token !== deps.revision()) return;
      labEstimate.value = { requirementId: item.id, conceptId, estimate };
    } catch (error) {
      console.error(error);
      showToast(`预估费用失败：${describeError(error)}`);
    } finally {
      courseBusy.value = false;
    }
  };

  const generateLab = async (item: requirementTypes.Requirement) => {
    const conceptId = labEstimate.value?.requirementId === item.id ? labEstimate.value.conceptId : null;
    const next = await courseAction(() => call(window.taskpilot.requirements.labGenerate(item.id, conceptId ?? undefined)), '生成 lab 失败');
    if (!next) return;
    labEstimate.value = null;
    deps.startWatching();
  };

  const addLab = async (item: requirementTypes.Requirement) => {
    const next = await courseAction(() => call(window.taskpilot.requirements.labPlace(item.id)), '写入实验仓库失败');
    if (!next) return false;
    await useTasksStore().reloadQueue();
    showToast(`已把「${next.course?.lab?.lab?.title ?? 'lab'}」加入实验仓库。`);
    return true;
  };

  const nextLab = async (item: requirementTypes.Requirement) => {
    await deps.open({ id: item.id });
    await loadLabEstimate(item);
  };

  const saveDraft = async (item: requirementTypes.Requirement, pack: CoursePack) => {
    courseBusy.value = true;
    const token = deps.revision();
    try {
      const saved = await call(window.taskpilot.requirements.courseSaveDraft(item.id, pack));
      if (token !== deps.revision()) return null;
      deps.upsert(saved.requirement);
      deps.renderDetail(saved.requirement);
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

  const draftSaved = ref<{ requirementId: string; ref: requirementTypes.CourseDraftSaved['ref']; pack: CoursePack } | null>(null);
  const confirmDraft = async (item: requirementTypes.Requirement) => {
    const saved = draftSaved.value;
    if (!saved || saved.requirementId !== item.id) return;
    const next = await courseAction(() => call(window.taskpilot.requirements.courseConfirmDraft(item.id, saved.ref.contentHash)), '确认课程包失败');
    if (!next) return;
    draftSaved.value = null;
    showToast(`已确认课程包「${saved.pack.title}」，开始规划学习路径。`);
    await deps.runStep(next, 'plan');
  };

  return { courseBusy, savePath, confirmPath, saveDraft, draftSaved, confirmDraft, labEstimate, loadLabEstimate, generateLab, addLab, nextLab };
};
