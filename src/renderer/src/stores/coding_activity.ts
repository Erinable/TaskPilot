import { ref, watch } from 'vue';
import { defineStore } from 'pinia';

import { call } from '@/lib/ipc.ts';
import { announceAgent } from '@/lib/feedback.ts';
import { codingOutcome, codingPhase } from '@/lib/coding_tracker.ts';
import type { CodingPhase } from '@/lib/coding_tracker.ts';
import { useExecutionStore } from './execution.ts';
import { useRepositoryIdentityStore } from './repository_identity.ts';
import { createStateWatcher } from './state_watcher.ts';

export type TrackedCoding = CodingPhase & { packageId: string; title: string };

// Follows every package the Coding Agent is working on, from any page: the
// top bar shows what runs and for how long, and the developer is told when the
// automatic flow stops, by a system notification when the window is in the
// background.
export const useCodingActivityStore = defineStore('codingActivity', () => {
  const execution = useExecutionStore();
  const repositories = useRepositoryIdentityStore();
  const runs = ref<TrackedCoding[]>([]);

  // A package's phase is read from its state, which only a 'packages' change
  // moves. A 'coding'-only change (a transcript event, a run registering or
  // finishing) re-reads just the packages that joined or left the active
  // list; the others keep the phase they had.
  let packagesStale = true;
  const watcher = createStateWatcher({
    name: 'coding-activity',
    domains: ['coding', 'packages'],
    onChange: (change) => {
      if (change.domains.includes('packages')) packagesStale = true;
    },
    read: async (isCurrent) => {
      const rereadAll = packagesStale;
      packagesStale = false;
      const active = await call(window.taskpilot.coding.active()).catch((error: unknown) => {
        packagesStale ||= rereadAll;
        throw error;
      });
      if (!isCurrent()) return;
      const activeIds = new Set(active.map((entry) => entry.packageId));
      const tracked = new Map(runs.value.map((entry) => [entry.packageId, entry]));
      const ids = [...new Set([...activeIds, ...tracked.keys()])];
      const next: TrackedCoding[] = [];
      for (const packageId of ids) {
        const kept = tracked.get(packageId);
        if (!rereadAll && kept && activeIds.has(packageId)) {
          next.push(kept);
          continue;
        }
        let task;
        try {
          task = await call(window.taskpilot.coding.get(packageId));
          if (!isCurrent()) return;
        } catch (error) {
          console.error('[coding-activity] read failed', error);
          continue;
        }
        const phase = codingPhase(task);
        if (phase) {
          next.push({ ...phase, packageId, title: task.title });
          continue;
        }
        if (!kept) continue;
        const outcome = codingOutcome(task);
        if (!outcome || (outcome.qa && execution.current?.id === packageId)) continue;
        announceAgent(outcome.text, outcome.tone, () => execution.open(packageId).catch((error) => console.error(error)));
      }
      runs.value = next;
    },
  });

  const refresh = () => {
    packagesStale = true;
    return watcher.refresh();
  };
  const start = () => {
    packagesStale = true;
    watcher.stop();
    watcher.start().catch((error) => console.error(error));
  };
  const stop = () => watcher.stop();

  watch(
    () => repositories.currentId,
    () => {
      runs.value = [];
      packagesStale = true;
      if (watcher.active()) start();
      else stop();
    },
    { flush: 'sync' },
  );

  return { runs, refresh, start, stop };
});
