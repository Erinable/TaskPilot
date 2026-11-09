// Release page: Release Manager drafts a version, notes and a checklist from
// the commits since the last release. TaskPilot never tags, commits or pushes;
// the only repository write is inserting the notes into a .md file on request.
import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';

import { call } from '@/lib/ipc.ts';
import { describeError } from '@/lib/errors.ts';
import { confirmAction, showToast } from '@/lib/feedback.ts';
import * as model from '@/lib/release_model.ts';
import type { IpcError } from '@/lib/ipc.ts';
import type * as envelopeTypes from '@shared/ipc/envelope.ts';
import type * as releaseTypes from '@shared/ipc/release.ts';
import { useRepositoryIdentityStore } from './repository_identity.ts';
import { createStateWatcher } from './state_watcher.ts';

export type NotesStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

// Typing pauses this long before the notes are saved.
const NOTES_DEBOUNCE_MS = 800;

export const useReleaseStore = defineStore('release', () => {
  const repository = useRepositoryIdentityStore();
  // ========== State ==========
  const state = ref<releaseTypes.ReleaseState | null>(null);
  const loadError = ref<string | null>(null);
  const draft = computed(() => state.value?.draft ?? null);
  const generating = computed(() => draft.value?.status === 'generating');

  // The notes editor's text is copied only when a new draft becomes ready,
  // so state events never overwrite what the user is typing.
  const notesText = ref('');
  let notesSource: string | null = null;
  let notesGeneration = 0;

  const apply = (next: releaseTypes.ReleaseState) => {
    state.value = next;
    const nextDraft = next.draft;
    const source = nextDraft?.status === 'ready' ? nextDraft.startedAt : null;
    if (source !== notesSource) {
      notesGeneration += 1;
      notesSaving = null;
      if (notesTimer !== null) clearTimeout(notesTimer);
      notesTimer = null;
    }
    if (source !== null && source !== notesSource) {
      notesText.value = nextDraft!.notesText;
      notesStatus.value = 'idle';
    }
    notesSource = source;
    if (next.startPoint?.kind === 'none' && commits.value === null) loadCommits().catch((error) => console.error(error));
  };

  const watcher = createStateWatcher({
    name: 'release',
    domains: ['release'],
    read: async (isCurrent) => {
      try {
        const next = await call(window.taskpilot.release.get());
        if (isCurrent()) {
          apply(next);
          loadError.value = null;
        }
      } catch (error) {
        if (isCurrent()) {
          console.error('[release] get failed', error);
          loadError.value = describeError(error);
        }
      }
    },
  });
  const load = () => watcher.refresh();

  const enter = () => watcher.start();

  const leave = ({ saveNotes = true } = {}) => {
    watcher.stop();
    if (saveNotes) flushNotes().catch((error) => console.error(error));
  };

  // ========== Start point ==========
  // Recent commits to pick from when there is no release or tag yet.
  const commits = ref<releaseTypes.ReleaseCommit[] | null>(null);
  const selectedStart = ref<string | null>(null);
  const startError = ref<string | null>(null);

  const loadCommits = async () => {
    const token = watcher.session();
    try {
      const next = await call(window.taskpilot.release.recentCommits());
      if (token === watcher.session()) commits.value = next;
    } catch (error) {
      if (token !== watcher.session()) return;
      console.error('[release] recent commits failed', error);
      commits.value = [];
      startError.value = `读取最近提交失败：${describeError(error)}`;
    }
  };

  const selectStart = (sha: string) => {
    selectedStart.value = sha;
    startError.value = null;
  };

  // ========== Generate ==========
  const generate = async () => {
    const startPoint = state.value?.startPoint;
    if (!startPoint) return;
    if (startPoint.kind === 'none' && !selectedStart.value) {
      startError.value = '请先选择从哪个提交开始。';
      return;
    }
    startError.value = null;
    try {
      apply(await call(window.taskpilot.release.generate(startPoint.kind === 'none' ? selectedStart.value! : undefined)));
    } catch (error) {
      console.error('[release] generate failed', error);
      // A bad start commit belongs under the commit picker.
      if ((error as IpcError).field === 'startCommit') startError.value = describeError(error);
      else showToast(`生成失败：${describeError(error)}`, 'error');
    }
  };

  const cancel = async () => {
    try {
      await call(window.taskpilot.release.cancel());
    } catch (error) {
      console.error('[release] cancel failed', error);
      showToast(`取消失败：${describeError(error)}`, 'error');
    }
    await load();
  };

  // ========== Draft edits ==========
  const notesStatus = ref<NotesStatus>('idle');
  let notesTimer: ReturnType<typeof setTimeout> | null = null;
  let notesSaving: Promise<boolean> | null = null;

  const update = async (input: releaseTypes.ReleaseDraftInput) => {
    const generation = notesGeneration;
    const repositoryId = repository.currentId;
    const next = await call(window.taskpilot.release.updateDraft(input));
    if (generation === notesGeneration && repositoryId === repository.currentId) apply(next);
  };

  const saveNotes = (): Promise<boolean> => {
    if (notesTimer !== null) clearTimeout(notesTimer);
    notesTimer = null;
    if (notesSaving) return notesSaving;
    const generation = notesGeneration;
    const text = notesText.value;
    notesStatus.value = 'saving';
    const pending = (async () => {
      try {
        await update({ notes: text });
        if (generation !== notesGeneration) return false;
        // Typing during the save leaves the newer text unsaved.
        notesStatus.value = notesText.value === text ? 'saved' : 'dirty';
        return true;
      } catch (error) {
        if (generation !== notesGeneration) return false;
        console.error('[release] save notes failed', error);
        notesStatus.value = 'error';
        showToast(`保存说明失败：${describeError(error)}`, 'error');
        return false;
      }
    })().finally(() => {
      if (notesSaving !== pending) return;
      notesSaving = null;
      if (generation === notesGeneration && notesStatus.value === 'dirty' && notesTimer === null) {
        notesTimer = setTimeout(() => {
          saveNotes().catch((error) => console.error(error));
        }, NOTES_DEBOUNCE_MS);
      }
    });
    notesSaving = pending;
    return pending;
  };

  const editNotes = (text: string) => {
    notesText.value = text;
    notesStatus.value = 'dirty';
    if (notesTimer !== null) clearTimeout(notesTimer);
    notesTimer = setTimeout(() => {
      saveNotes().catch((error) => console.error(error));
    }, NOTES_DEBOUNCE_MS);
  };

  // Waits for an in-flight save, then saves newer edits or retries a failed save.
  const flushNotes = async (): Promise<boolean> => {
    if (notesTimer !== null) clearTimeout(notesTimer);
    notesTimer = null;
    const generation = notesGeneration;
    while (generation === notesGeneration) {
      if (notesSaving && !(await notesSaving)) return false;
      if (generation !== notesGeneration) return false;
      if (notesStatus.value !== 'dirty' && notesStatus.value !== 'error') return true;
      if (!(await saveNotes())) return false;
    }
    return false;
  };

  const setChecked = async (index: number, value: boolean) => {
    const current = draft.value;
    if (!current) return;
    try {
      await update({ checked: model.toggleChecked(current.checked, index, value) });
    } catch (error) {
      console.error('[release] save checklist failed', error);
      showToast(`保存检查项失败：${describeError(error)}`, 'error');
    }
  };

  // ========== Finish ==========
  const finishing = ref(false);
  const canFinish = computed(() => draft.value?.status === 'ready' && model.allChecked(draft.value));

  const finish = async () => {
    const plan = draft.value?.plan;
    if (!canFinish.value || !plan || finishing.value) return;
    const generation = notesGeneration;
    const repositoryId = repository.currentId;
    const accepted = await confirmAction({
      title: '完成发布',
      body: `把 ${plan.nextVersion} 记入发布历史。TaskPilot 不会打 tag、提交或推送，这些请你自己完成。`,
      accept: '完成发布',
    });
    if (!accepted || generation !== notesGeneration || repositoryId !== repository.currentId) return;
    finishing.value = true;
    try {
      if (!(await flushNotes()) || generation !== notesGeneration || repositoryId !== repository.currentId) return;
      const release = await call(window.taskpilot.release.finish());
      showToast(`已记录发布 ${release.version}`);
    } catch (error) {
      console.error('[release] finish failed', error);
      showToast(`完成发布失败：${describeError(error)}`, 'error');
    } finally {
      finishing.value = false;
    }
    await load();
  };

  // ========== Notes output ==========
  const copyNotes = async () => {
    try {
      await navigator.clipboard.writeText(notesText.value);
      showToast('已复制更新说明');
    } catch (error) {
      console.error('[release] clipboard failed', error);
      showToast('复制失败：系统剪贴板不可用', 'error');
    }
  };

  const writeError = ref<string | null>(null);
  const writing = ref(false);

  const clearWriteError = () => {
    writeError.value = null;
  };

  // Resolves true once the notes are in the file. Errors stay under the path input.
  const writeNotes = async (path: string) => {
    const trimmed = path.trim();
    if (!trimmed) {
      writeError.value = '请填写文件路径。';
      return false;
    }
    if (!model.isMarkdownPath(trimmed)) {
      writeError.value = '只能写入 .md 文件。';
      return false;
    }
    writing.value = true;
    writeError.value = null;
    try {
      if (!(await flushNotes())) {
        writeError.value = '更新说明尚未保存，请重试保存后再写入文件。';
        return false;
      }
      const result = await call(window.taskpilot.release.writeNotes({ path: trimmed }));
      showToast(`已写入 ${result.path}`);
      return true;
    } catch (error) {
      console.error('[release] write notes failed', error);
      writeError.value = describeError(error);
      return false;
    } finally {
      writing.value = false;
    }
  };

  // ========== Milestones ==========
  const milestoneBusy = ref(false);
  const milestoneError = ref<string | null>(null);
  // Runs one milestone call; the reply is the whole release state.
  const milestoneCall = async (request: () => Promise<envelopeTypes.IpcResult<releaseTypes.ReleaseState>>, done?: string) => {
    if (milestoneBusy.value) return false;
    milestoneBusy.value = true;
    milestoneError.value = null;
    try {
      apply(await call(request()));
      if (done) showToast(done);
      return true;
    } catch (error) {
      milestoneError.value = describeError(error);
      return false;
    } finally {
      milestoneBusy.value = false;
    }
  };
  const createMilestone = (input: releaseTypes.MilestoneInput) =>
    milestoneCall(() => window.taskpilot.release.createMilestone(input), `已创建 ${input.version} 的版本计划。`);
  const updateMilestone = (id: string, input: releaseTypes.MilestoneInput) =>
    milestoneCall(() => window.taskpilot.release.updateMilestone(id, input), '版本计划已更新。');
  const deleteMilestone = async (milestone: releaseTypes.MilestoneView) => {
    const confirmed = await confirmAction({
      title: `删除 ${milestone.version} 的版本计划？`,
      body: '只删除这个计划，里面的需求和工作包都不受影响。',
      accept: '删除计划',
      danger: true,
    });
    return confirmed && milestoneCall(() => window.taskpilot.release.deleteMilestone(milestone.id), '版本计划已删除。');
  };
  const assignMilestone = (requirementId: string, milestoneId: string | null) =>
    milestoneCall(() => window.taskpilot.release.assignMilestone(requirementId, milestoneId), milestoneId ? '已放进版本计划。' : '已移出版本计划。');

  watch(
    () => repository.currentId,
    () => {
      notesGeneration += 1;
      notesSaving = null;
      if (notesTimer !== null) clearTimeout(notesTimer);
      notesTimer = null;
      watcher.invalidate();
      state.value = null;
      loadError.value = null;
      commits.value = null;
      selectedStart.value = null;
      startError.value = null;
      notesText.value = '';
      notesSource = null;
      notesStatus.value = 'idle';
      if (watcher.active()) load().catch((error) => console.error(error));
    },
    { flush: 'sync' },
  );

  return {
    // State
    state,
    loadError,
    draft,
    generating,
    notesText,
    load,
    // Milestones
    milestoneBusy,
    milestoneError,
    createMilestone,
    updateMilestone,
    deleteMilestone,
    assignMilestone,
    // Lifecycle
    enter,
    leave,
    // Start point
    commits,
    selectedStart,
    startError,
    selectStart,
    // Generate
    generate,
    cancel,
    // Draft edits
    notesStatus,
    editNotes,
    flushNotes,
    setChecked,
    // Finish
    finishing,
    canFinish,
    finish,
    // Notes output
    copyNotes,
    writeError,
    writing,
    clearWriteError,
    writeNotes,
  };
});
