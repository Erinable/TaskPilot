// Tutor's help per step of the open package. State events update mounted
// steps while a repository switch drops every entry and listener.
import { defineStore } from 'pinia';
import { ref } from 'vue';

import { call } from '@/lib/ipc.ts';
import { describeError } from '@/lib/errors.ts';
import { showToast } from '@/lib/feedback.ts';
import type * as tutorTypes from '@shared/ipc/tutor.ts';
import { createStateWatcher } from './state_watcher.ts';

const stepKey = (taskId: string, stepIndex: number) => `${taskId}:${stepIndex}`;

export const useTutorStore = defineStore('tutor', () => {
  const states = ref<Record<string, tutorTypes.TutorState>>({});
  const watching = new Set<string>();
  const pending = new Set<string>();

  const stateOf = (taskId: string, stepIndex: number) => states.value[stepKey(taskId, stepIndex)] ?? null;

  const watcher = createStateWatcher({
    name: 'tutor',
    domains: ['tutor'],
    initialRead: false,
    onChange: () => watching.forEach((key) => pending.add(key)),
    read: async () => {
      while (pending.size) {
        const key = pending.values().next().value as string;
        pending.delete(key);
        const [taskId, rawStep] = key.split(':');
        const next = await call(window.taskpilot.tutor.get(taskId, Number(rawStep)));
        if (watching.has(key)) states.value = { ...states.value, [key]: next };
      }
    },
  });

  const refresh = async (taskId: string, stepIndex: number) => {
    const key = stepKey(taskId, stepIndex);
    watching.add(key);
    await watcher.start();
    pending.add(key);
    await watcher.refresh();
  };

  const ask = async (taskId: string, stepIndex: number, level: number) => {
    const opened = watcher.session();
    try {
      const next = await call(window.taskpilot.tutor.ask(taskId, stepIndex, level));
      if (opened === watcher.session() && watching.has(stepKey(taskId, stepIndex))) states.value = { ...states.value, [stepKey(taskId, stepIndex)]: next };
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
    if (!watching.size) watcher.stop();
  };

  const reset = () => {
    watcher.stop();
    watching.clear();
    pending.clear();
    states.value = {};
  };

  return { stateOf, refresh, ask, cancel, copied, stop, reset };
});
