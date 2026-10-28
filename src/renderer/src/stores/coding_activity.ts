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

  const watcher = createStateWatcher({
    name: 'coding-activity',
    domains: ['coding', 'packages'],
    read: async (isCurrent) => {
      const active = await call(window.taskpilot.coding.active());
      if (!isCurrent()) return;
      const ids = [...new Set([...active.map((entry) => entry.packageId), ...runs.value.map((entry) => entry.packageId)])];
      const next: TrackedCoding[] = [];
      for (const packageId of ids) {
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
        if (!runs.value.some((entry) => entry.packageId === packageId)) continue;
        const outcome = codingOutcome(task);
        if (!outcome || (outcome.qa && execution.current?.id === packageId)) continue;
        announceAgent(outcome.text, outcome.tone, () => execution.open(packageId).catch((error) => console.error(error)));
      }
      runs.value = next;
    },
  });

  const refresh = () => watcher.refresh();
  const start = () => {
    watcher.stop();
    watcher.start().catch((error) => console.error(error));
  };
  const stop = () => watcher.stop();

  watch(
    () => repositories.currentId,
    () => {
      runs.value = [];
      if (watcher.active()) start();
      else stop();
    },
    { flush: 'sync' },
  );

  return { runs, refresh, start, stop };
});
