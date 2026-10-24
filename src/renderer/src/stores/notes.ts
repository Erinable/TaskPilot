// Learning notes: the list, the filters the notes page shows, and saving a
// grade comment as a note. Notes are global, so a repository switch leaves
// them alone.
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import { call } from '@/lib/ipc.ts';
import { describeError } from '@/lib/errors.ts';
import { showToast } from '@/lib/feedback.ts';
import { filterNotes } from '@/lib/notes_model.ts';
import type { NoteFilter } from '@/lib/notes_model.ts';
import type * as ipc from '@shared/ipc_types.ts';
import { useRepositoriesStore } from './repositories.ts';

export const useNotesStore = defineStore('notes', () => {
  // ========== List ==========
  const notes = ref<ipc.Note[]>([]);
  const loaded = ref(false);
  const filter = ref<NoteFilter>({ query: '', category: null, tag: null });
  const visible = computed(() => filterNotes(notes.value, filter.value));
  const tags = computed(() => [...new Set(notes.value.flatMap((note) => note.tags))].sort((a, b) => a.localeCompare(b)));

  const load = async () => {
    notes.value = await call(window.taskpilot.notes.list());
    loaded.value = true;
  };

  // ========== Editing ==========
  // Each resolves the saved note, or null after telling the developer why not.
  const create = async (input: ipc.NoteInput) => {
    try {
      const note = await call(window.taskpilot.notes.create(input));
      notes.value = [note, ...notes.value];
      return note;
    } catch (error) {
      console.error('[notes] create failed', error);
      showToast(`笔记没保存：${describeError(error)}`, 'error');
      return null;
    }
  };

  const update = async (id: string, input: Omit<ipc.NoteInput, 'source'>) => {
    try {
      const note = await call(window.taskpilot.notes.update(id, input));
      notes.value = [note, ...notes.value.filter((entry) => entry.id !== id)];
      return note;
    } catch (error) {
      console.error('[notes] update failed', error);
      showToast(`笔记没保存：${describeError(error)}`, 'error');
      return null;
    }
  };

  const remove = async (id: string) => {
    try {
      await call(window.taskpilot.notes.remove(id));
      notes.value = notes.value.filter((entry) => entry.id !== id);
      return true;
    } catch (error) {
      console.error('[notes] delete failed', error);
      showToast(`删除失败：${describeError(error)}`, 'error');
      return false;
    }
  };

  // ========== From grading ==========
  // One click under a grade comment: the comment becomes a note that points
  // back at the package and the line it was about.
  const saveComment = async (task: Pick<ipc.TaskView, 'id' | 'title'>, comment: ipc.GradeComment) => {
    const repository = useRepositoriesStore().current;
    const note = await create({
      title: comment.observation.length > 60 ? `${comment.observation.slice(0, 59)}…` : comment.observation,
      body: `${comment.observation}\n\n下次可以：${comment.betterWay}`,
      category: comment.category,
      tags: [],
      source: {
        repositoryId: repository?.id ?? null,
        repositoryName: repository?.name ?? null,
        packageId: task.id,
        packageTitle: task.title,
        file: comment.file,
        line: comment.line,
      },
    });
    if (note) showToast('已存到学习笔记。');
    return note;
  };

  return {
    // List
    notes,
    loaded,
    filter,
    visible,
    tags,
    load,
    // Editing
    create,
    update,
    remove,
    // From grading
    saveComment,
  };
});
