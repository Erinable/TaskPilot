// Tutor's help per step of the open package, and the polls that follow a
// running answer. Each step's panel watches its own entry while mounted; a
// repository switch drops every entry and stops every poll.
import { defineStore } from 'pinia';
import { ref } from 'vue';

import { call } from '@/lib/ipc.ts';
import { describeError } from '@/lib/errors.ts';
import { showToast } from '@/lib/feedback.ts';
import type * as tutorTypes from '@shared/ipc/tutor.ts';

export const TUTOR_POLL_MS = 1200;

const stepKey = (taskId: string, stepIndex: number) => `${taskId}:${stepIndex}`;

export const useTutorStore = defineStore('tutor', () => {
  // ========== Answers ==========
  const states = ref<Record<string, tutorTypes.TutorState>>({});
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let session = 0;

  const stateOf = (taskId: string, stepIndex: number) => states.value[stepKey(taskId, stepIndex)] ?? null;

  const stop = (taskId: string, stepIndex: number) => {
    const key = stepKey(taskId, stepIndex);
    const timer = timers.get(key);
    if (timer) clearTimeout(timer);
    timers.delete(key);
  };

  const apply = (taskId: string, stepIndex: number, next: tutorTypes.TutorState) => {
    states.value = { ...states.value, [stepKey(taskId, stepIndex)]: next };
    stop(taskId, stepIndex);
    if (next.status === 'running') {
      timers.set(
        stepKey(taskId, stepIndex),
        setTimeout(() => refresh(taskId, stepIndex).catch((error) => console.error(error)), TUTOR_POLL_MS),
      );
    }
  };

  const refresh = async (taskId: string, stepIndex: number) => {
    const opened = session;
    const next = await call(window.taskpilot.tutor.get(taskId, stepIndex));
    if (opened === session) apply(taskId, stepIndex, next);
  };

  // Opens `level` of the step's hint ladder.
  const ask = async (taskId: string, stepIndex: number, level: number) => {
    const opened = session;
    try {
      const next = await call(window.taskpilot.tutor.ask(taskId, stepIndex, level));
      if (opened === session) apply(taskId, stepIndex, next);
    } catch (error) {
      console.error('[tutor] ask failed', error);
      showToast(`导师暂时无法回答：${describeError(error)}`);
    }
  };

  const cancel = async (taskId: string, stepIndex: number) => {
    await call(window.taskpilot.tutor.cancel(taskId, stepIndex)).catch((error) => console.error(error));
    await refresh(taskId, stepIndex);
  };

  const copied = (taskId: string) => call(window.taskpilot.tutor.copied(taskId)).catch((error) => console.error(error));

  // ========== Lifecycle ==========
  const reset = () => {
    session += 1;
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    states.value = {};
  };

  return {
    // Answers
    stateOf,
    refresh,
    ask,
    cancel,
    copied,
    stop,
    // Lifecycle
    reset,
  };
});
