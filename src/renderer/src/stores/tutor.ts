// Tutor's help per step of the open package. State events update mounted
// steps while a repository switch drops every entry and listener.
import { defineStore } from 'pinia';
import { ref } from 'vue';

import { call } from '@/lib/ipc.ts';
import { describeError } from '@/lib/errors.ts';
import { showToast } from '@/lib/feedback.ts';
import type * as tutorTypes from '@shared/ipc/tutor.ts';
import { useRepositoryIdentityStore } from './repository_identity.ts';

const stepKey = (taskId: string, stepIndex: number) => `${taskId}:${stepIndex}`;

export const useTutorStore = defineStore('tutor', () => {
  const states = ref<Record<string, tutorTypes.TutorState>>({});
  const watching = new Set<string>();
  const pending = new Set<string>();
  let unsubscribe: (() => void) | null = null;
  let reading = false;
  let queued = false;
  let session = 0;

  const stateOf = (taskId: string, stepIndex: number) => states.value[stepKey(taskId, stepIndex)] ?? null;

  const read = async () => {
    if (reading) {
      queued = true;
      return;
    }
    reading = true;
    try {
      while (pending.size) {
        const key = pending.values().next().value as string;
        pending.delete(key);
        const [taskId, rawStep] = key.split(':');
        const next = await call(window.taskpilot.tutor.get(taskId, Number(rawStep)));
        if (watching.has(key)) states.value = { ...states.value, [key]: next };
      }
    } finally {
      reading = false;
      if (queued || pending.size) {
        queued = false;
        read().catch((error) => console.error('[tutor] refresh failed', error));
      }
    }
  };

  const startWatching = () => {
    if (unsubscribe) return;
    const repositories = useRepositoryIdentityStore();
    unsubscribe = window.taskpilot.state.onChanged((change) => {
      if (change.repositoryId !== repositories.currentId) return;
      if (!change.domains.includes('tutor')) return;
      for (const key of watching) pending.add(key);
      read().catch((error) => console.error('[tutor] refresh failed', error));
    });
  };

  const refresh = async (taskId: string, stepIndex: number) => {
    const key = stepKey(taskId, stepIndex);
    watching.add(key);
    startWatching();
    pending.add(key);
    await read();
  };

  const ask = async (taskId: string, stepIndex: number, level: number) => {
    const opened = session;
    try {
      const next = await call(window.taskpilot.tutor.ask(taskId, stepIndex, level));
      if (opened === session && watching.has(stepKey(taskId, stepIndex))) states.value = { ...states.value, [stepKey(taskId, stepIndex)]: next };
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

  const stop = (taskId: string, stepIndex: number) => {
    const key = stepKey(taskId, stepIndex);
    watching.delete(key);
    pending.delete(key);
    if (!watching.size) {
      unsubscribe?.();
      unsubscribe = null;
    }
  };

  const reset = () => {
    session += 1;
    queued = false;
    watching.clear();
    pending.clear();
    unsubscribe?.();
    unsubscribe = null;
    states.value = {};
  };

  return { stateOf, refresh, ask, cancel, copied, stop, reset };
});
