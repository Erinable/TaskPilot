import { ref, watch } from 'vue';
import { defineStore } from 'pinia';

import { call } from '@/lib/ipc.ts';
import { announceAgent } from '@/lib/feedback.ts';
import { codingOutcome, codingPhase } from '@/lib/coding_tracker.ts';
import type { CodingPhase } from '@/lib/coding_tracker.ts';
import { useExecutionStore } from './execution.ts';
import { useRepositoryIdentityStore } from './repository_identity.ts';

export type TrackedCoding = CodingPhase & { packageId: string; title: string };

// Follows every package the Coding Agent is working on, from any page: the
// top bar shows what runs and for how long, and the developer is told when the
// automatic flow stops, by a system notification when the window is in the
// background.
export const useCodingActivityStore = defineStore('codingActivity', () => {
  const execution = useExecutionStore();
  const repositories = useRepositoryIdentityStore();
  const runs = ref<TrackedCoding[]>([]);
  let unsubscribe: (() => void) | null = null;
  let session = 0;
  let reading = false;
  let queued = false;

  const read = async () => {
    const token = session;
    if (reading) {
      queued = true;
      return;
    }
    reading = true;
    try {
      const active = await call(window.taskpilot.coding.active());
      if (token !== session) return;
      const ids = [...new Set([...active.map((entry) => entry.packageId), ...runs.value.map((entry) => entry.packageId)])];
      const next: TrackedCoding[] = [];
      for (const packageId of ids) {
        let task;
        try {
          task = await call(window.taskpilot.coding.get(packageId));
          if (token !== session) return;
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
      if (token === session) runs.value = next;
    } finally {
      reading = false;
      if (queued) {
        queued = false;
        await read();
      }
    }
  };

  const refresh = () => read();
  const start = () => {
    stop();
    unsubscribe = window.taskpilot.state.onChanged((change) => {
      if (change.repositoryId !== repositories.currentId) return;
      if (change.domains.some((domain) => domain === 'coding' || domain === 'packages')) read().catch((error) => console.error(error));
    });
    read().catch((error) => console.error(error));
  };
  const stop = () => {
    session += 1;
    queued = false;
    unsubscribe?.();
    unsubscribe = null;
  };

  watch(
    () => repositories.currentId,
    () => {
      runs.value = [];
      if (unsubscribe) start();
      else stop();
    },
    { flush: 'sync' },
  );

  return { runs, refresh, start, stop };
});
