// Release page: Release Manager drafts a version, notes and a checklist from
// the commits since the last release. TaskPilot never tags, commits or pushes;
// the only repository write is inserting the notes into a .md file on request.
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import { call } from '@/lib/ipc.ts';
import { describeError } from '@/lib/errors.ts';
import { confirmAction, showToast } from '@/lib/feedback.ts';
import * as model from '@/lib/release_model.ts';
import type { IpcError } from '@/lib/ipc.ts';
import type * as ipc from '@shared/ipc_types.ts';

export type NotesStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

// Typing pauses this long before the notes are saved.
const NOTES_DEBOUNCE_MS = 800;

export const useReleaseStore = defineStore('release', () => {
  // ========== State ==========
  const state = ref<ipc.ReleaseState | null>(null);
  const loadError = ref<string | null>(null);
  const draft = computed(() => state.value?.draft ?? null);
  const generating = computed(() => draft.value?.status === 'generating');

  // The notes editor's text. Copied from the draft only when a new draft
  // becomes ready, so polling never overwrites what the user is typing.
  const notesText = ref('');
  let notesSource: string | null = null;

  const apply = (next: ipc.ReleaseState) => {
    state.value = next;
    const nextDraft = next.draft;
    const source = nextDraft?.status === 'ready' ? nextDraft.startedAt : null;
    if (source !== null && source !== notesSource) {
      notesText.value = nextDraft!.notesText;
      notesStatus.value = 'idle';
    }
    notesSource = source;
    if (next.startPoint?.kind === 'none' && commits.value === null) loadCommits().catch((error) => console.error(error));
  };

  const load = async () => {
    try {
      apply(await call(window.taskpilot.release.get()));
      loadError.value = null;
    } catch (error) {
      console.error('[release] get failed', error);
      loadError.value = describeError(error);
    }
    schedulePoll();
  };

  // ========== Polling ==========
  // Polls only while the page is open and a draft is being generated.
  let active = false;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;

  const stopPolling = () => {
    if (pollTimer !== null) clearTimeout(pollTimer);
    pollTimer = null;
  };

  const schedulePoll = () => {
    stopPolling();
    if (active && generating.value)
      pollTimer = setTimeout(() => {
        load().catch((error) => console.error(error));
      }, model.POLL_MS);
  };

  const enter = async () => {
    active = true;
    await load();
  };

  const leave = () => {
    active = false;
    stopPolling();
    flushNotes().catch((error) => console.error(error));
  };

  // ========== Start point ==========
  // Recent commits to pick from when there is no release or tag yet.
  const commits = ref<ipc.ReleaseCommit[] | null>(null);
  const selectedStart = ref<string | null>(null);
  const startError = ref<string | null>(null);

  const loadCommits = async () => {
    try {
      commits.value = await call(window.taskpilot.release.recentCommits());
    } catch (error) {
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
    schedulePoll();
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

  const update = async (input: ipc.ReleaseDraftInput) => apply(await call(window.taskpilot.release.updateDraft(input)));

  const saveNotes = async () => {
    if (notesTimer !== null) clearTimeout(notesTimer);
    notesTimer = null;
    notesStatus.value = 'saving';
    const text = notesText.value;
    try {
      await update({ notes: text });
      // Typing during the save leaves the newer text unsaved.
      notesStatus.value = notesText.value === text ? 'saved' : 'dirty';
    } catch (error) {
      console.error('[release] save notes failed', error);
      notesStatus.value = 'error';
      showToast(`保存说明失败：${describeError(error)}`, 'error');
    }
  };

  const editNotes = (text: string) => {
    notesText.value = text;
    notesStatus.value = 'dirty';
    if (notesTimer !== null) clearTimeout(notesTimer);
    notesTimer = setTimeout(() => {
      saveNotes().catch((error) => console.error(error));
    }, NOTES_DEBOUNCE_MS);
  };

  // Saves pending edits now (blur, leaving the page, before finishing).
  const flushNotes = async () => {
    if (notesStatus.value === 'dirty') await saveNotes();
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
    if (!canFinish.value || !plan) return;
    const accepted = await confirmAction({
      title: '完成发布',
      body: `把 ${plan.nextVersion} 记入发布历史。TaskPilot 不会打 tag、提交或推送，这些请你自己完成。`,
      accept: '完成发布',
    });
    if (!accepted) return;
    finishing.value = true;
    try {
      await flushNotes();
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
      await flushNotes();
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
  const milestoneCall = async (request: () => Promise<ipc.IpcResult<ipc.ReleaseState>>, done?: string) => {
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
  const createMilestone = (input: ipc.MilestoneInput) =>
    milestoneCall(() => window.taskpilot.release.createMilestone(input), `已创建 ${input.version} 的版本计划。`);
  const updateMilestone = (id: string, input: ipc.MilestoneInput) =>
    milestoneCall(() => window.taskpilot.release.updateMilestone(id, input), '版本计划已更新。');
  const deleteMilestone = async (milestone: ipc.MilestoneView) => {
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
    // Polling
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
