// The repositories TaskPilot knows and the switch between them. A switch
// stops every poll, asks the main process to cancel running work (after the
// user confirms), then reloads every store for the new repository.
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import { call } from '@/lib/ipc.ts';
import { describeError } from '@/lib/errors.ts';
import { confirmAction, showToast } from '@/lib/feedback.ts';
import { useAppStore } from './app.ts';
import { useExecutionStore } from './execution.ts';
import { useNotificationsStore } from './notifications.ts';
import { useReleaseStore } from './release.ts';
import { useRequirementsStore } from './requirements.ts';
import { useSettingsStore } from './settings.ts';
import { useTasksStore } from './tasks.ts';
import type * as ipc from '@shared/ipc_types.ts';

const BUSY_LABELS: Record<ipc.BusyKind, string> = {
  requirement: '需求',
  review: 'QA 审查',
  adjudication: '偏差裁决',
  baseline: '基线测量',
  release: 'Release Manager',
  environment: '环境管家',
  tutor: '导师讲解',
  coding: 'Coding Agent',
  reference: '参考答案',
  grade: '导师判卷',
};

export const useRepositoriesStore = defineStore('repositories', () => {
  // ========== List ==========
  const repositories = ref<ipc.Repository[]>([]);
  const currentId = ref<string | null>(null);
  const current = computed(() => repositories.value.find((repo) => repo.id === currentId.value) ?? null);
  // Bumped after every switch; the main content is keyed on it so each view
  // remounts and reloads its own state.
  const generation = ref(0);
  const switching = ref(false);

  const apply = (list: ipc.RepositoryList) => {
    repositories.value = list.repositories;
    currentId.value = list.current;
  };

  const refresh = async () => {
    try {
      apply(await call(window.taskpilot.repositories.list()));
    } catch (error) {
      console.error('[repositories] list failed', error);
    }
  };

  // ========== Switching ==========
  // Reloads everything the views read for the newly open repository.
  const reloadAll = async () => {
    const app = useAppStore();
    useNotificationsStore().useRepository(currentId.value);
    await Promise.all([useTasksStore().reloadQueue(), useRequirementsStore().init(), app.refreshWorkspaceStatus(), app.refreshActivity()]);
    if (app.view === 'settings') await useSettingsStore().load();
    generation.value += 1;
  };

  // Settles what belongs to the old repository: unsaved settings, the notes
  // editor, polls. Resolves false when the user stays.
  const leaveCurrent = async () => {
    const app = useAppStore();
    if (!(await app.confirmLeaveSettings())) return false;
    await useReleaseStore().flushNotes();
    const execution = useExecutionStore();
    useRequirementsStore().stopPolling();
    useReleaseStore().leave();
    execution.close();
    if (app.view === 'execution') await app.navigate('queue');
    return true;
  };

  // Lists running work and asks before cancelling it. True to go ahead.
  const confirmCancel = async () => {
    const busy = await call(window.taskpilot.repositories.busy());
    if (busy.length === 0) return true;
    const lines = busy.map((run) => `${BUSY_LABELS[run.kind]}：${run.label}`).join('；');
    return confirmAction({
      title: '切换仓库会取消正在运行的任务',
      body: `${lines}。被取消的任务会标为已取消，回到这个仓库后可以重试。`,
      accept: '取消任务并切换',
      danger: true,
    });
  };

  // Shared by switch and add: confirm, cancel, then reload. False when the
  // user backed out or the main process refused.
  const runSwitch = async (action: () => Promise<ipc.IpcResult<ipc.RepositoryList>>) => {
    if (switching.value) return false;
    switching.value = true;
    try {
      if (!(await confirmCancel()) || !(await leaveCurrent())) return false;
      apply(await call(action()));
      await reloadAll();
      return true;
    } catch (error) {
      console.error('[repositories] switch failed', error);
      showToast(`切换仓库失败：${describeError(error)}`);
      return false;
    } finally {
      switching.value = false;
    }
  };

  const switchTo = async (id: string) => {
    if (id === currentId.value) return true;
    const switched = await runSwitch(() => window.taskpilot.repositories.switch(id));
    if (switched) showToast(`已切换到 ${current.value?.name ?? '仓库'}`);
    return switched;
  };

  // ========== Adding and relocating ==========
  // Asks for a folder; null when the picker was dismissed.
  const pickFolder = async () => {
    try {
      return await call(window.taskpilot.workspace.pickRoot());
    } catch (error) {
      console.error(error);
      showToast(`无法打开目录选择器：${describeError(error)}`);
      return null;
    }
  };

  // Picks a folder, registers it and opens it.
  const add = async () => {
    const root = await pickFolder();
    if (!root) return false;
    const added = await runSwitch(() => window.taskpilot.repositories.add(root, true));
    if (added) showToast(`已添加并切换到 ${current.value?.name ?? '仓库'}`);
    return added;
  };

  // Points a moved repository at its new folder. No switch, so no cancel.
  const relocate = async (id: string) => {
    const root = await pickFolder();
    if (!root) return false;
    try {
      apply(await call(window.taskpilot.repositories.relocate(id, root)));
      if (id === currentId.value) await reloadAll();
      showToast('已更新仓库位置。');
      return true;
    } catch (error) {
      console.error('[repositories] relocate failed', error);
      showToast(`更新位置失败：${describeError(error)}`);
      return false;
    }
  };

  return {
    // List
    repositories,
    currentId,
    current,
    generation,
    switching,
    refresh,
    // Switching
    switchTo,
    // Adding and relocating
    add,
    relocate,
  };
});
