import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import { call } from '@/lib/ipc.ts';
import type * as packageTypes from '@shared/ipc/packages.ts';

export const useTasksStore = defineStore('tasks', () => {
  // ========== Queue ==========
  const tasks = ref<packageTypes.TaskView[]>([]);
  const pendingCount = computed(() => tasks.value.filter((task) => task.status !== 'done').length);

  let generation = 0;
  const reloadQueue = async () => {
    const token = ++generation;
    const next = await call(window.taskpilot.tasks.list());
    if (token === generation) tasks.value = next;
  };

  // Puts a fresher view of one package in its place without reading the whole
  // queue; a package the queue does not list yet waits for the next reload.
  const adoptTask = (task: packageTypes.TaskView) => {
    tasks.value = tasks.value.map((entry) => (entry.id === task.id ? task : entry));
  };

  const reset = () => {
    generation += 1;
    tasks.value = [];
  };

  return {
    // Queue
    tasks,
    pendingCount,
    reloadQueue,
    adoptTask,
    reset,
  };
});
