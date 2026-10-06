import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import { call } from '@/lib/ipc.ts';
import type * as ipc from '@shared/ipc_types.ts';

export const useTasksStore = defineStore('tasks', () => {
  // ========== Queue ==========
  const tasks = ref<ipc.TaskView[]>([]);
  const pendingCount = computed(() => tasks.value.filter((task) => task.status !== 'done').length);

  const reloadQueue = async () => { tasks.value = await call(window.taskpilot.listTasks()); };

  return {
    // Queue
    tasks, pendingCount, reloadQueue,
  };
});
