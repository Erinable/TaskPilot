// The full activity feed, a few business days at a time. Opening the view
// starts from the newest page, as does a repository switch; a page for an
// earlier opening is dropped.
import { defineStore } from 'pinia';
import { ref } from 'vue';

import { call } from '@/lib/ipc.ts';
import { describeError } from '@/lib/errors.ts';
import type * as ipc from '@shared/ipc_types.ts';

export const useActivityFeedStore = defineStore('activityFeed', () => {
  // ========== Feed ==========
  const days = ref<ipc.ActivityPage['days']>([]);
  const nextBefore = ref<string | null>(null);
  const retentionDays = ref(0);
  const loading = ref(false);
  const loaded = ref(false);
  const error = ref<string | null>(null);
  let session = 0;

  const loadPage = async (before: string | null) => {
    const opened = session;
    loading.value = true;
    try {
      const page = await call(window.taskpilot.activity.page(before));
      if (opened !== session) return;
      days.value = before ? [...days.value, ...page.days] : page.days;
      nextBefore.value = page.nextBefore;
      retentionDays.value = page.retentionDays;
      error.value = null;
    } catch (caught) {
      console.error('[activity] page failed', caught);
      if (opened === session) error.value = describeError(caught);
    } finally {
      if (opened === session) {
        loading.value = false;
        loaded.value = true;
      }
    }
  };

  const reset = () => {
    session += 1;
    days.value = [];
    nextBefore.value = null;
    retentionDays.value = 0;
    loading.value = false;
    loaded.value = false;
    error.value = null;
  };

  const open = () => {
    reset();
    return loadPage(null);
  };

  return {
    // Feed
    days,
    nextBefore,
    retentionDays,
    loading,
    loaded,
    error,
    loadPage,
    reset,
    open,
  };
});
