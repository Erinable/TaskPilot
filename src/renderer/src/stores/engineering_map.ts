// The engineering map the map view shows, read from stored summaries and
// the tracked file tree. Opening the view starts from nothing, as does a
// repository switch; an answer for an earlier opening is dropped.
import { defineStore } from 'pinia';
import { ref } from 'vue';

import { call } from '@/lib/ipc.ts';
import { describeError } from '@/lib/errors.ts';
import type * as activityTypes from '@shared/ipc/activity.ts';

export const useEngineeringMapStore = defineStore('engineeringMap', () => {
  // ========== Map ==========
  const map = ref<activityTypes.EngineeringMap | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);
  let session = 0;

  const load = async () => {
    const opened = session;
    loading.value = true;
    try {
      const next = await call(window.taskpilot.engineeringMap.get());
      if (opened !== session) return;
      map.value = next;
      error.value = null;
    } catch (caught) {
      console.error(caught);
      if (opened === session) error.value = describeError(caught);
    } finally {
      if (opened === session) loading.value = false;
    }
  };

  const reset = () => {
    session += 1;
    map.value = null;
    loading.value = false;
    error.value = null;
  };

  const open = () => {
    reset();
    return load();
  };

  return {
    // Map
    map,
    loading,
    error,
    load,
    reset,
    open,
  };
});
