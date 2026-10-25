// Learning notes: the list (every note without its body), the open note,
// the filters the notes page shows, and saving a grade comment as a note.
// The files can change outside TaskPilot, so the page polls a revision and
// only refetches when it moved. Notes are global, so a repository switch
// leaves them alone.
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import { call } from '@/lib/ipc.ts';
import { describeError } from '@/lib/errors.ts';
import { confirmAction, showToast } from '@/lib/feedback.ts';
import * as model from '@/lib/notes_model.ts';
import * as markdown from '@shared/note_markdown.ts';
import type * as ipc from '@shared/ipc_types.ts';
import { useRepositoriesStore } from './repositories.ts';

const POLL_MS = 2000;
// Drafts are reactive proxies, which IPC cannot clone; they are plain JSON.
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));

export const useNotesStore = defineStore('notes', () => {
  // ========== List ==========
  const notes = ref<ipc.NoteMeta[]>([]);
  const loaded = ref(false);
  const revision = ref<number | null>(null);
  const directory = ref('');
  const custom = ref(false);
  const unavailable = ref<string | null>(null);
  const truncated = ref(false);
  const filter = ref<model.NoteFilter>({ query: '', category: null, tag: null });
  // Ids whose body matched the current query, from the main process.
  const bodyMatches = ref(new Set<string>());
  const visible = computed(() => model.filterNotes(notes.value, filter.value, bodyMatches.value));
  const tags = computed(() => [...new Set(notes.value.flatMap((note) => model.allTags(note)))].sort((a, b) => a.localeCompare(b)));
  const byTitle = computed(() => model.titleIndex(notes.value));
  const findByTitle = (title: string) => byTitle.value.get(markdown.titleKey(title)) ?? null;

  const applyList = (list: ipc.NoteList) => {
    notes.value = list.notes;
    revision.value = list.revision;
    directory.value = list.directory;
    custom.value = list.custom;
    unavailable.value = list.unavailable;
    truncated.value = list.truncated;
    loaded.value = true;
  };

  // Resolves whether anything changed since the last load.
  const load = async () => {
    const list = await call(window.taskpilot.notes.list(revision.value));
    if (!list) return false;
    applyList(list);
    return true;
  };

  let searchGeneration = 0;
  const search = async (query: string) => {
    const generation = (searchGeneration += 1);
    const ids = query.trim() ? await call(window.taskpilot.notes.search(query)) : [];
    if (generation === searchGeneration) bodyMatches.value = new Set(ids);
  };

  // ========== Pages ==========
  // The notes page works like a small blog: the index (optionally one
  // category or tag) and one page per note, with back and forward.
  // heading: a [[note#heading]] to scroll to once the note is shown.
  type Route = { name: 'index'; category: ipc.GradeCategory | null; tag: string | null } | { name: 'note'; id: string; heading: string | null };
  const history = ref<Route[]>([{ name: 'index', category: null, tag: null }]);
  const position = ref(0);
  const route = computed(() => history.value[position.value]);
  const canGoBack = computed(() => position.value > 0);
  const canGoForward = computed(() => position.value < history.value.length - 1);
  // The open note is being edited (otherwise it is read).
  const editing = ref(false);

  // Unsaved edits are only dropped after the developer agrees.
  const confirmLeave = async () =>
    !dirty.value || confirmAction({ title: '放弃未保存的修改？', body: '这篇笔记还没有保存。', accept: '放弃并离开', danger: true });

  const show = async (target: Route) => {
    editing.value = false;
    if (target.name === 'index') {
      filter.value = { ...filter.value, category: target.category, tag: target.tag };
      closeNote();
      return;
    }
    if (current.value?.id !== target.id) await openNote(target.id);
  };

  // Resolves false when the developer stayed on the page.
  const navigate = async (target: Route) => {
    if (!(await confirmLeave())) return false;
    history.value = [...history.value.slice(0, position.value + 1), target];
    position.value = history.value.length - 1;
    await show(target);
    return true;
  };
  const goBack = async () => {
    if (!canGoBack.value || !(await confirmLeave())) return;
    position.value -= 1;
    // A page whose note is gone is skipped.
    await show(route.value).catch(() => show({ name: 'index', category: null, tag: null }));
  };
  const goForward = async () => {
    if (!canGoForward.value || !(await confirmLeave())) return;
    position.value += 1;
    await show(route.value).catch(() => show({ name: 'index', category: null, tag: null }));
  };
  const goIndex = (options: { category?: ipc.GradeCategory | null; tag?: string | null } = {}) =>
    navigate({ name: 'index', category: options.category ?? null, tag: options.tag ?? null });
  const goNote = (id: string, heading: string | null = null) => navigate({ name: 'note', id, heading });

  // A rename changes the note's id; pages that pointed at it follow.
  const renamePages = (from: string, to: string) => {
    if (from === to) return;
    history.value = history.value.map((entry) => (entry.name === 'note' && entry.id === from ? { ...entry, id: to } : entry));
  };

  const startEditing = () => {
    if (current.value && !current.value.frontmatterError) editing.value = true;
  };
  const stopEditing = async () => {
    if (!(await confirmLeave())) return;
    if (current.value) draft.value = toDraft(current.value);
    conflict.value = false;
    editing.value = false;
  };

  // ========== Open note ==========
  // The note being read or edited, and the edit in progress.
  type Draft = { title: string; body: string; category: ipc.GradeCategory | null; tags: string[]; summary: string | null };
  const current = ref<ipc.Note | null>(null);
  const draft = ref<Draft | null>(null);
  // The file changed on disk while there were unsaved edits.
  const conflict = ref(false);
  const saving = ref(false);
  const summarizing = ref(false);
  const toDraft = (note: ipc.Note): Draft => ({ title: note.title, body: note.body, category: note.category, tags: [...note.tags], summary: note.summary });
  const dirty = computed(() => {
    const note = current.value;
    const edit = draft.value;
    if (!note || !edit) return false;
    return JSON.stringify(edit) !== JSON.stringify(toDraft(note));
  });

  const openNote = async (id: string) => {
    const note = await call(window.taskpilot.notes.get(id));
    current.value = note;
    draft.value = toDraft(note);
    conflict.value = false;
  };

  const closeNote = () => {
    current.value = null;
    draft.value = null;
    conflict.value = false;
  };

  // After a list refresh: follow the open note's file. Unsaved edits stay
  // and are marked conflicting; a clean editor just shows the new text.
  const syncOpen = async () => {
    const note = current.value;
    if (!note) return;
    const meta = notes.value.find((entry) => entry.id === note.id);
    if (!meta) {
      if (dirty.value) conflict.value = true;
      else await goIndex();
      return;
    }
    if (meta.version === note.version) return;
    if (dirty.value) {
      conflict.value = true;
      return;
    }
    await openNote(note.id);
  };

  const refresh = async () => {
    if (await load()) await syncOpen();
  };

  // Drops the developer's edits for what is on disk now.
  const discard = async () => {
    const note = current.value;
    if (!note) return;
    if (notes.value.some((entry) => entry.id === note.id)) await openNote(note.id);
    else await show({ name: 'index', category: null, tag: null });
  };

  // previousId: the id before a rename, whose entry goes.
  const afterSave = (saved: ipc.NoteSaved, previousId: string = saved.note.id) => {
    current.value = saved.note;
    draft.value = toDraft(saved.note);
    conflict.value = false;
    const { body: _body, ...meta } = saved.note;
    notes.value = [meta, ...notes.value.filter((entry) => entry.id !== meta.id && entry.id !== previousId)];
    // Renames touch other notes; the next poll brings their versions.
    revision.value = null;
  };

  // force: overwrite a file that changed on disk.
  const save = async ({ force = false, renameLinks = false } = {}) => {
    const note = current.value;
    const edit = draft.value;
    if (!note || !edit || saving.value) return null;
    saving.value = true;
    try {
      const saved = await call(window.taskpilot.notes.update(note.id, { ...plain(edit), baseVersion: note.version, force, renameLinks }));
      afterSave(saved, note.id);
      renamePages(note.id, saved.note.id);
      if (saved.relinked) showToast(`已同步更新 ${saved.relinked} 篇笔记里的链接。`);
      return saved.note;
    } catch (error) {
      if ((error as { code?: string }).code === 'note_conflict') {
        conflict.value = true;
        return null;
      }
      console.error('[notes] save failed', error);
      showToast(`笔记没保存：${describeError(error)}`, 'error');
      return null;
    } finally {
      saving.value = false;
    }
  };

  // Each resolves the saved note, or null after telling the developer why not.
  // open: go to the new note's page, in the editor.
  const create = async (input: ipc.NoteInput, { autoRename = false, open = false } = {}) => {
    if (open && !(await confirmLeave())) return null;
    try {
      const saved = await call(window.taskpilot.notes.create(plain(input), autoRename));
      const { body: _body, ...meta } = saved.note;
      notes.value = [meta, ...notes.value];
      revision.value = null;
      if (open) {
        afterSave(saved);
        history.value = [...history.value.slice(0, position.value + 1), { name: 'note', id: saved.note.id, heading: null }];
        position.value = history.value.length - 1;
        editing.value = true;
      }
      return saved.note;
    } catch (error) {
      console.error('[notes] create failed', error);
      showToast(`笔记没保存：${describeError(error)}`, 'error');
      return null;
    }
  };

  const remove = async (id: string) => {
    try {
      await call(window.taskpilot.notes.remove(id));
      notes.value = notes.value.filter((entry) => entry.id !== id);
      history.value = history.value.filter((entry) => entry.name !== 'note' || entry.id !== id);
      position.value = Math.min(position.value, history.value.length - 1);
      if (current.value?.id === id) {
        closeNote();
        await show(route.value).catch(() => show({ name: 'index', category: null, tag: null }));
      }
      return true;
    } catch (error) {
      console.error('[notes] delete failed', error);
      showToast(`删除失败：${describeError(error)}`, 'error');
      return false;
    }
  };

  // Tutor writes the summary grading reads. Unsaved edits are saved first,
  // so the summary is of what the developer sees.
  const summarize = async () => {
    if (summarizing.value || !current.value) return;
    if (dirty.value && !(await save())) return;
    const note = current.value;
    summarizing.value = true;
    try {
      const saved = await call(window.taskpilot.notes.summarize(note.id, note.version));
      const keep = draft.value;
      afterSave(saved);
      if (keep && current.value) draft.value = { ...keep, summary: saved.note.summary };
      showToast('导师写好了总结。');
    } catch (error) {
      if ((error as { code?: string }).code === 'note_conflict') conflict.value = true;
      console.error('[notes] summarize failed', error);
      showToast(`总结没写成：${describeError(error)}`, 'error');
    } finally {
      summarizing.value = false;
    }
  };

  // ========== Folder ==========
  // Picks a folder in the native dialog and switches to it; false when cancelled.
  const resetPages = () => {
    history.value = [{ name: 'index', category: null, tag: null }];
    position.value = 0;
    editing.value = false;
    closeNote();
  };

  const chooseDirectory = async () => {
    if (!(await confirmLeave())) return false;
    const picked = await call(window.taskpilot.notes.pickDirectory());
    if (!picked) return false;
    resetPages();
    applyList(await call(window.taskpilot.notes.setDirectory(picked)));
    return true;
  };

  const resetDirectory = async () => {
    if (!(await confirmLeave())) return;
    resetPages();
    applyList(await call(window.taskpilot.notes.setDirectory(null)));
  };

  const revealDirectory = () => call(window.taskpilot.notes.reveal());

  // A link in a note opens in the system browser or mail app.
  const openUrl = (url: string) => call(window.taskpilot.notes.openUrl(url));

  let pollTimer: number | null = null;
  const startPolling = () => {
    if (pollTimer !== null) return;
    pollTimer = window.setInterval(() => refresh().catch((error) => console.error('[notes] refresh failed', error)), POLL_MS);
  };
  const stopPolling = () => {
    if (pollTimer !== null) window.clearInterval(pollTimer);
    pollTimer = null;
  };

  // ========== From grading ==========
  // One click under a grade comment: the comment becomes a note that points
  // back at the package and the line it was about.
  const saveComment = async (task: Pick<ipc.TaskView, 'id' | 'title'>, comment: ipc.GradeComment) => {
    const repository = useRepositoriesStore().current;
    const note = await create(
      {
        title: markdown.toTitle(comment.observation.length > 60 ? `${comment.observation.slice(0, 59)}…` : comment.observation),
        body: `${comment.observation}\n\n## 下次可以\n\n${comment.betterWay}\n`,
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
      },
      { autoRename: true },
    );
    if (note) showToast('已存到学习笔记。');
    return note;
  };

  return {
    // List
    notes,
    loaded,
    directory,
    custom,
    unavailable,
    truncated,
    filter,
    visible,
    tags,
    findByTitle,
    load,
    refresh,
    search,
    // Pages
    route,
    canGoBack,
    canGoForward,
    editing,
    navigate,
    goBack,
    goForward,
    goIndex,
    goNote,
    startEditing,
    stopEditing,
    // Open note
    current,
    draft,
    dirty,
    conflict,
    saving,
    summarizing,
    openNote,
    closeNote,
    discard,
    save,
    create,
    remove,
    summarize,
    // Folder
    chooseDirectory,
    resetDirectory,
    revealDirectory,
    openUrl,
    startPolling,
    stopPolling,
    // From grading
    saveComment,
  };
});
