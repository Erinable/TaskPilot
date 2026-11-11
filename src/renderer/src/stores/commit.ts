// Committing a finished package: the preview of what would be committed,
// the editable message and the result. Opening a package's panel starts
// from nothing, as does a repository switch.
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import { call } from '@/lib/ipc.ts';
import { describeError } from '@/lib/errors.ts';
import { showToast } from '@/lib/feedback.ts';
import type * as commitTypes from '@shared/ipc/commit.ts';

export const useCommitStore = defineStore('commit', () => {
  // ========== Preview ==========
  const taskId = ref<string | null>(null);
  const preview = ref<commitTypes.CommitPreview | null>(null);
  const message = ref('');
  // Optional companion files ticked for this commit (project config / lockfiles).
  const extra = ref<string[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);
  let session = 0;
  let previewRequest = 0;

  const load = async () => {
    const id = taskId.value;
    if (!id) return;
    const opened = session;
    const request = ++previewRequest;
    loading.value = true;
    try {
      const next = await call(window.taskpilot.commit.preview(id));
      if (opened !== session || request !== previewRequest) return;
      committed.value = null;
      preview.value = next;
      message.value = next.message;
      // Offer companion project config and lockfiles with the next commit.
      extra.value = [...next.optional];
      error.value = null;
    } catch (caught) {
      console.error('[commit] preview failed', caught);
      if (opened === session && request === previewRequest) error.value = describeError(caught);
    } finally {
      if (opened === session && request === previewRequest) loading.value = false;
    }
  };

  // ========== Commit ==========
  const committing = ref(false);
  const committed = ref<commitTypes.CommitResult | null>(null);

  // All files this panel can commit, including companion config/lockfiles.
  // Leaving an optional checkbox off does not make that file disappear.
  const unsavedFiles = (id: string) =>
    taskId.value === id && preview.value ? (committed.value ? 0 : preview.value.files.length + preview.value.optional.length) : null;

  const fileCount = computed(() => (preview.value?.files.length ?? 0) + extra.value.length);
  const canCommit = computed(() => fileCount.value > 0 && message.value.trim().length > 0 && !committing.value);

  const commit = async () => {
    const id = taskId.value;
    if (!id || !preview.value || !canCommit.value) return;
    const opened = session;
    committing.value = true;
    try {
      // The preview is reactive; IPC's structured clone rejects its proxies.
      const result = await call(window.taskpilot.commit.create(id, message.value, [...preview.value.files], [...extra.value]));
      if (opened !== session) return;
      committed.value = result;
      showToast(`已提交 ${result.files.length} 个文件`);
    } catch (caught) {
      console.error('[commit] create failed', caught);
      showToast(`提交失败：${describeError(caught)}`);
      // The list may be stale (changes_changed); show the current one.
      if (opened === session) await load();
    } finally {
      if (opened === session) committing.value = false;
    }
  };

  // ========== Lifecycle ==========
  const reset = () => {
    session += 1;
    previewRequest += 1;
    taskId.value = null;
    preview.value = null;
    message.value = '';
    extra.value = [];
    loading.value = false;
    error.value = null;
    committing.value = false;
    committed.value = null;
  };

  const open = (id: string) => {
    reset();
    taskId.value = id;
    return load();
  };

  return {
    // Preview
    preview,
    message,
    extra,
    fileCount,
    loading,
    error,
    load,
    // Commit
    committing,
    committed,
    canCommit,
    unsavedFiles,
    commit,
    // Lifecycle
    reset,
    open,
  };
});
