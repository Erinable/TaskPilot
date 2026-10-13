// Cost page: what the AI team spent, by member, day, model and work item.
// Reported amounts and token-based estimates are kept apart; calls with
// neither are counted, never guessed. Prices sync only on request.
import { defineStore } from 'pinia';
import { ref } from 'vue';

import { call } from '@/lib/ipc.ts';
import { describeError } from '@/lib/errors.ts';
import { showToast } from '@/lib/feedback.ts';
import type * as ipc from '@shared/ipc_types.ts';

export const useCostsStore = defineStore('costs', () => {
  // ========== Report ==========
  const days = ref<ipc.CostRange>(7);
  const report = ref<ipc.CostReport | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);
  let generation = 0;

  const load = async () => {
    const token = ++generation;
    loading.value = true;
    error.value = null;
    try {
      const value = await call(window.taskpilot.costs.report(days.value));
      if (token === generation) report.value = value;
    } catch (cause) {
      if (token === generation) error.value = describeError(cause);
    } finally {
      if (token === generation) loading.value = false;
    }
  };

  const setDays = (next: ipc.CostRange) => {
    days.value = next;
    load().catch((cause) => console.error(cause));
  };

  // ========== Prices ==========
  const syncing = ref(false);
  const syncError = ref<string | null>(null);

  const syncPrices = async () => {
    if (syncing.value) return;
    syncing.value = true;
    syncError.value = null;
    try {
      await call(window.taskpilot.costs.syncPrices());
      showToast('价格已同步，估算已更新。');
      await load();
    } catch (cause) {
      syncError.value = describeError(cause);
    } finally {
      syncing.value = false;
    }
  };

  return {
    // Report
    days,
    report,
    loading,
    error,
    load,
    setDays,
    // Prices
    syncing,
    syncError,
    syncPrices,
  };
});
