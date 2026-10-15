import { ref } from 'vue';
import { defineStore } from 'pinia';

import { call } from '@/lib/ipc.ts';
import { announceAgent } from '@/lib/feedback.ts';
import { codingOutcome, codingPhase } from '@/lib/coding_tracker.ts';
import type { CodingPhase } from '@/lib/coding_tracker.ts';
import { useExecutionStore } from './execution.ts';

export const CODING_ACTIVITY_POLL_MS = 3000;

export type TrackedCoding = CodingPhase & { packageId: string; title: string };

// Follows every package the Coding Agent is working on, from any page: the
// top bar shows what runs and for how long, and the developer is told when
// the automatic flow stops, by a system notification when the window is
// in the background.
export const useCodingActivityStore = defineStore('codingActivity', () => {
  const execution = useExecutionStore();
  const runs = ref<TrackedCoding[]>([]);
  let timer: ReturnType<typeof setInterval> | null = null;

  const refresh = async () => {
    const active = await call(window.taskpilot.coding.active());
    const ids = [...new Set([...active.map((entry) => entry.packageId), ...runs.value.map((entry) => entry.packageId)])];
    const next: TrackedCoding[] = [];
    for (const packageId of ids) {
      let task;
      try {
        task = await call(window.taskpilot.coding.get(packageId));
      } catch (error) {
        // Gone, for example after a repository switch: stop following it.
        console.error('[coding-activity] read failed', error);
        continue;
      }
      const phase = codingPhase(task);
      if (phase) {
        next.push({ ...phase, packageId, title: task.title });
        continue;
      }
      // Only packages followed while moving get an announcement; one that was
      // already waiting when the app opened does not.
      if (!runs.value.some((entry) => entry.packageId === packageId)) continue;
      const outcome = codingOutcome(task);
      // The open execution page announces its own QA results.
      if (!outcome || (outcome.qa && execution.current?.id === packageId)) continue;
      announceAgent(outcome.text, outcome.tone, () => execution.open(packageId).catch((error) => console.error(error)));
    }
    runs.value = next;
  };

  const start = (intervalMs = CODING_ACTIVITY_POLL_MS) => {
    stop();
    refresh().catch((error) => console.error(error));
    timer = setInterval(() => refresh().catch((error) => console.error(error)), intervalMs);
  };
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };

  return { runs, refresh, start, stop };
});
