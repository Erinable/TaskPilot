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
import type * as courseTypes from '@shared/ipc/courses.ts';
import type { CoursePack } from '@shared/course_pack.ts';

// `view` only shows a pack; `confirm` asks to use the pending pack in use;
// `import` asks to copy a picked file into the global folder.
export type PreviewMode = 'view' | 'confirm' | 'import';

export const useCoursesStore = defineStore('courses', () => {
  // ========== List ==========
  const list = ref<courseTypes.CourseList | null>(null);
  const loading = ref(false);
  const current = computed(() => list.value?.current ?? null);

  const load = async () => {
    loading.value = true;
    try {
      list.value = await call(window.taskpilot.courses.list());
    } catch (error) {
      console.error(error);
      showToast(`读取课程包失败：${describeError(error)}`);
    } finally {
      loading.value = false;
    }
  };

  const reset = () => {
    list.value = null;
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
    busy.value = true;
    try {
      list.value = await call(window.taskpilot.courses.select(id));
    } catch (error) {
      console.error(error);
      showToast(`切换课程包失败：${describeError(error)}`);
      return;
    } finally {
      busy.value = false;
    }
    const state = list.value.current.state;
    if (state.status === 'pending') await openPreview(state.ref.id);
    else if (state.status === 'ok') showToast(`之后的规划和判卷改用「${titleOf(list.value.current.ref.id)}」。`);
  };

  const titleOf = (id: string) => list.value?.entries.find((entry) => entry.id === id)?.title ?? id;

  // ========== Confirm ==========
  // With the hash of the content shown: a file changed in between is refused.
  const confirm = async () => {
    const shown = preview.value;
    if (!shown || previewMode.value !== 'confirm') return;
    busy.value = true;
    try {
      await call(window.taskpilot.workspace.confirmCourse(shown.ref.id, shown.ref.contentHash));
      closePreview();
      showToast(`已确认课程包「${shown.pack.title}」，之后的规划和判卷用它。`);
      await load();
    } catch (error) {
      console.error(error);
      showToast(`确认失败：${describeError(error)}`);
      // The file may have changed: show what it says now.
      await load();
      if (current.value?.state.status === 'pending') await openPreview(current.value.state.ref.id);
    } finally {
      busy.value = false;
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
    if (!shown || previewMode.value !== 'import') return;
    busy.value = true;
    try {
      list.value = await call(window.taskpilot.courses.import(shown.ref.contentHash));
      closePreview();
      showToast(`已导入「${shown.pack.title}」。选用并确认后才会生效。`);
    } catch (error) {
      console.error(error);
      showToast(`导入失败：${describeError(error)}`);
    } finally {
      busy.value = false;
    }
  };

  // ========== Course view ==========
  // The pack the 课程 view shows on the right.
  const viewed = ref<courseTypes.CoursePreview | null>(null);

  const view = async (id: string) => {
    try {
      viewed.value = await call(window.taskpilot.courses.preview(id));
    } catch (error) {
      console.error(error);
      showToast(`读取课程包失败：${describeError(error)}`);
    }
  };

  // Opens the view's list, and the pack in use when nothing is shown yet.
  const loadView = async () => {
    await load();
    const shown = viewed.value?.ref.id;
    const id = shown && list.value?.entries.some((entry) => entry.id === shown) ? shown : list.value?.current.ref.id;
    if (id) await view(id);
  };

  // A refusal that names a field of the form (`id`, `rubric[1].label`) is
  // returned for the form to show there; anything else is a toast.
  const fieldError = (error: unknown, action: string) => {
    console.error(error);
    if (error instanceof IpcError && error.field && error.code !== 'unknown') return { field: error.field, message: describeError(error) };
    showToast(`${action}失败：${describeError(error)}`);
    return null;
  };

  const saved = (result: courseTypes.CourseSaved) => {
    list.value = result.list;
    viewed.value = result.preview;
  };

  // Copies a pack into the global folder as `id`, then shows the copy.
  const copy = async (sourceId: string, id: string) => {
    busy.value = true;
    try {
      saved(await call(window.taskpilot.courses.copy(sourceId, id)));
      showToast(`已复制为「${id}」。可以编辑它；在仓库里用之前要先确认。`);
      return null;
    } catch (error) {
      return fieldError(error, '复制');
    } finally {
      busy.value = false;
    }
  };

  // Saves an imported or copied pack. The main process validates it again;
  // a saved pack has new content, so it is pending until confirmed again.
  const save = async (pack: CoursePack) => {
    busy.value = true;
    try {
      saved(await call(window.taskpilot.courses.save(pack.id, pack)));
      showToast('已保存。内容变了，要在本机重新确认后才会用于规划和判卷。', 'info');
      return null;
    } catch (error) {
      return fieldError(error, '保存');
    } finally {
      busy.value = false;
    }
  };

  return {
    // List
    list,
    loading,
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
    copy,
    save,
  };
});
