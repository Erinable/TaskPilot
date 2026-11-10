import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import { call } from '@/lib/ipc.ts';
import { describeError } from '@/lib/errors.ts';
import { useRepositoryIdentityStore } from './repository_identity.ts';
import type * as packageTypes from '@shared/ipc/packages.ts';

export const useTasksStore = defineStore('tasks', () => {
  // ========== Queue ==========
  const tasks = ref<packageTypes.TaskView[]>([]);
  const pendingCount = computed(() => tasks.value.filter((task) => task.status !== 'done').length);

  const loading = ref(false);
  const loaded = ref(false);
  const error = ref<string | null>(null);
  let generation = 0;
  const reloadQueue = async () => {
    const token = ++generation;
    const repositoryId = useRepositoryIdentityStore().currentId;
    const isCurrent = () => token === generation && repositoryId === useRepositoryIdentityStore().currentId;
    loading.value = true;
    try {
      const next = await call(window.taskpilot.tasks.list());
      if (!isCurrent()) return;
      tasks.value = next;
      loaded.value = true;
      error.value = null;
    } catch (failure) {
      if (!isCurrent()) return;
      error.value = describeError(failure);
      throw failure;
    } finally {
      if (isCurrent()) loading.value = false;
    }
  };

  // Puts a fresher view of one package in its place without reading the whole
  // queue; a package the queue does not list yet waits for the next reload.
  const adoptTask = (task: packageTypes.TaskView) => {
    tasks.value = tasks.value.map((entry) => (entry.id === task.id ? task : entry));
  };

  const reset = () => {
    generation += 1;
    tasks.value = [];
    loading.value = false;
    loaded.value = false;
    error.value = null;
  };

  return {
    // Queue
    tasks,
    loading,
    loaded,
    error,
    pendingCount,
    reloadQueue,
    adoptTask,
    reset,
  };
});
