// Committing a finished package: the preview of what would be committed,
// the editable message and the result. Opening a package's panel starts
// from nothing, as does a repository switch.
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import { call } from '@/lib/ipc.ts';
import { describeError } from '@/lib/errors.ts';
import { showToast } from '@/lib/feedback.ts';
import type * as ipc from '@shared/ipc_types.ts';

export const useCommitStore = defineStore('commit', () => {
  // ========== Preview ==========
  const taskId = ref<string | null>(null);
  const preview = ref<ipc.CommitPreview | null>(null);
  const message = ref('');
  const loading = ref(false);
  const error = ref<string | null>(null);
  let session = 0;

  const load = async () => {
    const id = taskId.value;
    if (!id) return;
    const opened = session;
    loading.value = true;
    try {
      const next = await call(window.taskpilot.commit.preview(id));
      if (opened !== session) return;
      preview.value = next;
      message.value = next.message;
      error.value = null;
    } catch (caught) {
      console.error('[commit] preview failed', caught);
      if (opened === session) error.value = describeError(caught);
    } finally {
      if (opened === session) loading.value = false;
    }
  };

  // ========== Commit ==========
  const committing = ref(false);
  const committed = ref<ipc.CommitResult | null>(null);

  const canCommit = computed(() => Boolean(preview.value?.files.length) && message.value.trim().length > 0 && !committing.value);

  const commit = async () => {
    const id = taskId.value;
    if (!id || !preview.value || !canCommit.value) return;
    const opened = session;
    committing.value = true;
    try {
      const result = await call(window.taskpilot.commit.create(id, message.value, preview.value.files));
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
    taskId.value = null;
    preview.value = null;
    message.value = '';
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
    loading,
    error,
    load,
    // Commit
    committing,
    committed,
    canCommit,
    commit,
    // Lifecycle
    reset,
    open,
  };
});
