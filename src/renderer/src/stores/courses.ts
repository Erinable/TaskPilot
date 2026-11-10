// Course packs, for the 课程 view and the settings page: the packs the open
// repository can pick from, the one in use, picking one on this machine,
// the full preview shown before a pack is confirmed, importing a pack file,
// and copying a pack to edit it. Also the built-in default pack, for
// records from before packs.
//
// [人工决策-2026-10-26 15:38:21] 确认前把整包内容展示给用户；contentHash 变化时列出改动的字段。
// 选包只写本机 workspace.json，只影响之后的规划和判卷。
// [人工决策-2026-10-27 00:55:52] 浏览、复制再改和编辑在侧栏的「课程」视图；设置页只留信任确认和导入。
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import { IpcError, call } from '@/lib/ipc.ts';
import { describeError } from '@/lib/errors.ts';
import { showToast } from '@/lib/feedback.ts';
import { draftOf } from '@/lib/course_model.ts';
import type { CourseDraft } from '@/lib/course_model.ts';
import * as localDraft from '@/lib/local_draft.ts';
import { isCourseDraft } from '@/lib/draft_models.ts';
import { createStateWatcher } from './state_watcher.ts';
import { useRepositoryIdentityStore } from './repository_identity.ts';
import type * as courseTypes from '@shared/ipc/courses.ts';
import type { CoursePack } from '@shared/course_pack.ts';

// `view` only shows a pack; `confirm` asks to use the pending pack in use;
// `import` asks to copy a picked file into the global folder.
export type PreviewMode = 'view' | 'confirm' | 'import';

export const useCoursesStore = defineStore('courses', () => {
  // ========== List ==========
  const list = ref<courseTypes.CourseList | null>(null);
  const loading = ref(false);
  const loadError = ref<string | null>(null);
  const viewError = ref<string | null>(null);
  const viewedId = ref<string | null>(null);
  // User packs are global. Keep their drafts across view and repository resets;
  // requirement drafts use a repository/requirement key supplied by the editor.
  const drafts = ref<Record<string, CourseDraft>>({});
  const draftSessions = new Map<string, { baseline: string; draft: localDraft.LocalDraft<CourseDraft> }>();
  const editSession = (key: string, pack: CoursePack) => {
    const initial = draftOf(pack);
    const baseline = localDraft.draftFingerprint(initial);
    let session = draftSessions.get(key);
    if (!session || session.baseline !== baseline) {
      session?.draft.stop();
      session = { baseline, draft: localDraft.createLocalDraft({ key: localDraft.draftKey(['course', key]), initial, validate: isCourseDraft }) };
      draftSessions.set(key, session);
      drafts.value[key] = session.draft.value.value;
    }
    return session.draft;
  };
  const editDraft = (key: string, pack: CoursePack) => editSession(key, pack).value.value;
  const editDraftState = (key: string, pack: CoursePack) => editSession(key, pack).state;
  const restoreDraft = (key: string, pack: CoursePack) => editSession(key, pack).restore();
  const hasDraft = (key: string) => {
    if (drafts.value[key]) return true;
    try {
      return (globalThis.localStorage?.getItem(localDraft.draftKey(['course', key])) ?? null) !== null;
    } catch {
      return false;
    }
  };
  const acceptDraft = (key: string, saved: CourseDraft) => {
    const session = draftSessions.get(key);
    if (!session) return;
    session.draft.accept(saved);
    session.baseline = localDraft.draftFingerprint(saved);
  };
  const discardDraft = (key: string) => {
    const session = draftSessions.get(key);
    session?.draft.clear();
    session?.draft.stop();
    draftSessions.delete(key);
    delete drafts.value[key];
  };
  const current = computed(() => list.value?.current ?? null);
  // Bumped by every list read and by reset(): only the latest answer applies.
  let listGeneration = 0;

  const load = async () => {
    const token = ++listGeneration;
    loading.value = true;
    try {
      const next = await call(window.taskpilot.courses.list());
      if (token === listGeneration) {
        list.value = next;
        loadError.value = null;
      }
    } catch (error) {
      if (token !== listGeneration) return;
      console.error(error);
      loadError.value = describeError(error);
      showToast(`读取课程包失败：${loadError.value}`);
    } finally {
      if (token === listGeneration) loading.value = false;
    }
  };

  const reset = () => {
    watcher.stop();
    listGeneration += 1;
    viewGeneration += 1;
    actionGeneration += 1;
    selectionWritePending = false;
    busy.value = false;
    list.value = null;
    loading.value = false;
    loadError.value = null;
    viewError.value = null;
    viewedId.value = null;
    viewed.value = null;
    closePreview();
  };

  // ========== Default pack ==========
  // Grades and notes from before packs were programming. The pack ships with
  // the app and never changes while it runs, so it is read once and kept
  // across repository switches.
  const defaultPack = ref<CoursePack | null>(null);

  const loadDefault = async () => {
    if (!defaultPack.value) defaultPack.value = await call(window.taskpilot.courses.default());
  };

  // ========== Preview ==========
  const preview = ref<courseTypes.CoursePreview | courseTypes.CourseImport | null>(null);
  const previewMode = ref<PreviewMode>('view');
  const previewOpen = ref(false);
  const busy = ref(false);
  let actionGeneration = 0;
  const beginAction = () => {
    busy.value = true;
    const token = ++actionGeneration;
    const repositoryId = useRepositoryIdentityStore().currentId;
    return () => token === actionGeneration && repositoryId === useRepositoryIdentityStore().currentId;
  };
  const replaceList = (next: courseTypes.CourseList) => {
    listGeneration += 1;
    loading.value = false;
    loadError.value = null;
    list.value = next;
  };

  const show = (data: courseTypes.CoursePreview | courseTypes.CourseImport, mode: PreviewMode) => {
    preview.value = data;
    previewMode.value = mode;
    previewOpen.value = true;
  };

  const closePreview = () => {
    previewOpen.value = false;
  };

  // The pending pack in use is shown to confirm; any other only to read.
  const openPreview = async (id: string) => {
    try {
      const data = await call(window.taskpilot.courses.preview(id));
      const pending = current.value?.state.status === 'pending' && current.value.state.ref.id === id && data.trust === 'pending';
      show(data, pending ? 'confirm' : 'view');
    } catch (error) {
      console.error(error);
      showToast(`读取课程包失败：${describeError(error)}`);
    }
  };

  // ========== Select ==========
  // Null goes back to taskpilot.toml's choice. A pack that needs confirming
  // opens its preview right away, since it is not used until then.
  const select = async (id: string | null) => {
    if (busy.value) return;
    const isCurrent = beginAction();
    try {
      const next = await call(window.taskpilot.courses.select(id));
      if (!isCurrent()) return;
      replaceList(next);
      const state = next.current.state;
      if (state.status === 'pending') await openPreview(state.ref.id);
      else if (state.status === 'ok') showToast(`之后的规划和判卷改用「${titleOf(next.current.ref.id)}」。`);
    } catch (error) {
      if (!isCurrent()) return;
      console.error(error);
      showToast(`切换课程包失败：${describeError(error)}`);
    } finally {
      if (isCurrent()) busy.value = false;
    }
  };

  const titleOf = (id: string) => list.value?.entries.find((entry) => entry.id === id)?.title ?? id;

  // ========== Confirm ==========
  // With the hash of the content shown: a file changed in between is refused.
  const confirm = async () => {
    const shown = preview.value;
    if (busy.value || !shown || previewMode.value !== 'confirm') return;
    const isCurrent = beginAction();
    try {
      await call(window.taskpilot.workspace.confirmCourse(shown.ref.id, shown.ref.contentHash));
      if (!isCurrent()) return;
      closePreview();
      showToast(`已确认课程包「${shown.pack.title}」，之后的规划和判卷用它。`);
      await load();
    } catch (error) {
      if (!isCurrent()) return;
      console.error(error);
      showToast(`确认失败：${describeError(error)}`);
      // The file may have changed: show what it says now.
      await load();
      if (isCurrent() && current.value?.state.status === 'pending') await openPreview(current.value.state.ref.id);
    } finally {
      if (isCurrent()) busy.value = false;
    }
  };

  // ========== Import ==========
  // Picks and validates a file; it is copied only after the preview.
  const pickImport = async () => {
    try {
      const picked = await call(window.taskpilot.courses.pickImport());
      if (picked) show(picked, 'import');
    } catch (error) {
      console.error(error);
      showToast(`导入失败：${describeError(error)}`);
    }
  };

  const importPicked = async () => {
    const shown = preview.value;
    if (busy.value || !shown || previewMode.value !== 'import') return;
    const isCurrent = beginAction();
    try {
      const next = await call(window.taskpilot.courses.import(shown.ref.contentHash));
      if (!isCurrent()) return;
      replaceList(next);
      closePreview();
      showToast(`已导入「${shown.pack.title}」。选用并确认后才会生效。`);
    } catch (error) {
      if (!isCurrent()) return;
      console.error(error);
      showToast(`导入失败：${describeError(error)}`);
    } finally {
      if (isCurrent()) busy.value = false;
    }
  };

  // ========== Course view ==========
  // The pack the 课程 view shows on the right.
  const viewed = ref<courseTypes.CoursePreview | null>(null);
  let viewGeneration = 0;
  let selectionWritePending = false;

  const showViewed = (next: courseTypes.CoursePreview) => {
    viewGeneration += 1;
    viewedId.value = next.ref.id;
    viewed.value = next;
    viewError.value = null;
  };

  const view = async (id: string) => {
    const token = ++viewGeneration;
    viewedId.value = id;
    viewError.value = null;
    try {
      const next = await call(window.taskpilot.courses.preview(id));
      if (token === viewGeneration) showViewed(next);
    } catch (error) {
      if (token !== viewGeneration) return;
      console.error(error);
      viewError.value = describeError(error);
      showToast(`读取课程包失败：${viewError.value}`);
    }
  };

  // A refresh must not replace a selection made while its list was loading.
  const loadView = async () => {
    const token = viewGeneration;
    await load();
    if (token !== viewGeneration || selectionWritePending) return;
    const shown = viewedId.value;
    const id = shown && list.value?.entries.some((entry) => entry.id === shown) ? shown : list.value?.current.ref.id;
    if (id) await view(id);
  };

  // While a view that lists packs is open, a pick, copy, save or
  // confirmation made elsewhere reloads the list, and in the 课程 view the
  // pack shown. The views load on mount themselves, so start() only subscribes.
  let showsPack = false;
  const watcher = createStateWatcher({
    name: 'courses',
    domains: ['courses', 'workspace'],
    initialRead: false,
    read: async () => {
      if (showsPack) await loadView();
      else await load();
    },
  });

  // withPack: the 课程 view, which also shows one pack's content.
  const enter = (withPack = false) => {
    showsPack = withPack;
    return watcher.start();
  };

  const leave = () => watcher.stop();

  // A refusal that names a field of the form (`id`, `rubric[1].label`) is
  // returned for the form to show there; anything else is a toast.
  const fieldError = (error: unknown, action: string) => {
    console.error(error);
    if (error instanceof IpcError && error.field && error.code !== 'unknown') return { field: error.field, message: describeError(error) };
    showToast(`${action}失败：${describeError(error)}`);
    return null;
  };

  // Copies and saves share the view's selection generation. A newer selection
  // wins, and applying a write invalidates every older preview and list read.
  const saved = (result: courseTypes.CourseSaved, token: number) => {
    replaceList(result.list);
    if (token === viewGeneration) showViewed(result.preview);
  };

  // Copies a pack into the global folder as `id`, then shows the copy.
  const copy = async (sourceId: string, id: string) => {
    if (busy.value) return { field: 'id', message: '正在处理课程包，请稍后再试。' };
    const isCurrent = beginAction();
    const token = ++viewGeneration;
    selectionWritePending = true;
    try {
      const result = await call(window.taskpilot.courses.copy(sourceId, id));
      if (!isCurrent()) return null;
      saved(result, token);
      showToast(`已复制为「${id}」。可以编辑它；在仓库里用之前要先确认。`);
      return null;
    } catch (error) {
      if (!isCurrent()) return null;
      return fieldError(error, '复制') ?? { field: 'id', message: `复制失败：${describeError(error)}` };
    } finally {
      if (isCurrent()) {
        selectionWritePending = false;
        busy.value = false;
      }
    }
  };

  // Saves an imported or copied pack. The main process validates it again;
  // a saved pack has new content, so it is pending until confirmed again.
  const save = async (pack: CoursePack) => {
    if (busy.value) return { field: 'pack', message: '正在处理课程包，请稍后再试。' };
    const isCurrent = beginAction();
    const token = viewedId.value === pack.id ? ++viewGeneration : null;
    selectionWritePending = token !== null;
    try {
      const result = await call(window.taskpilot.courses.save(pack.id, pack));
      if (isCurrent()) {
        if (token === null) replaceList(result.list);
        else saved(result, token);
        showToast('已保存。内容变了，要在本机重新确认后才会用于规划和判卷。', 'info');
      }
      return null;
    } catch (error) {
      if (!isCurrent()) return { field: 'pack', message: '仓库已切换，草稿仍保留；请在当前仓库重新保存。' };
      return fieldError(error, '保存') ?? { field: 'pack', message: `保存失败：${describeError(error)}` };
    } finally {
      if (isCurrent()) {
        selectionWritePending = false;
        busy.value = false;
      }
    }
  };

  return {
    // List
    list,
    loading,
    loadError,
    viewError,
    viewedId,
    drafts,
    editDraft,
    editDraftState,
    acceptDraft,
    restoreDraft,
    hasDraft,
    discardDraft,
    current,
    load,
    reset,
    // Default pack
    defaultPack,
    loadDefault,
    // Preview
    preview,
    previewMode,
    previewOpen,
    busy,
    openPreview,
    closePreview,
    // Select
    select,
    titleOf,
    // Confirm
    confirm,
    // Import
    pickImport,
    importPicked,
    // Course view
    viewed,
    view,
    loadView,
    enter,
    leave,
    copy,
    save,
  };
});
