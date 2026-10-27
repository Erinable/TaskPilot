// The repositories TaskPilot knows and the switch between them. A switch
// stops every poll, asks the main process to cancel running work (after the
// user confirms), then reloads every store for the new repository.
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import { call } from '@/lib/ipc.ts';
import { runLabel } from '@/lib/activity.ts';
import { describeError } from '@/lib/errors.ts';
import { confirmAction, showToast } from '@/lib/feedback.ts';
import { useActivityFeedStore } from './activity_feed.ts';
import { useAppStore } from './app.ts';
import { useCommitStore } from './commit.ts';
import { useCoursesStore } from './courses.ts';
import { useEngineeringMapStore } from './engineering_map.ts';
import { useExecutionStore } from './execution.ts';
import { useMasteryStore } from './mastery.ts';
import { useNotificationsStore } from './notifications.ts';
import { useOnboardingStore } from './onboarding.ts';
import { useReleaseStore } from './release.ts';
import { useRequirementsStore } from './requirements.ts';
import { useSettingsStore } from './settings.ts';
import { useTasksStore } from './tasks.ts';
import { useTutorStore } from './tutor.ts';
import type * as envelopeTypes from '@shared/ipc/envelope.ts';
import type * as repositoryTypes from '@shared/ipc/repositories.ts';
import type * as requirementTypes from '@shared/ipc/requirements.ts';

const BUSY_LABELS: Record<repositoryTypes.BusyKind, string> = {
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
  const repositories = ref<repositoryTypes.Repository[]>([]);
  const currentId = ref<string | null>(null);
  const current = computed(() => repositories.value.find((repo) => repo.id === currentId.value) ?? null);
  // Bumped after every switch; the main content is keyed on it so each view
  // remounts and reloads its own state.
  const generation = ref(0);
  const switching = ref(false);

  const apply = (list: repositoryTypes.RepositoryList) => {
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
    // What the views read for the old repository; each view reloads on remount.
    useActivityFeedStore().reset();
    useCommitStore().reset();
    useCoursesStore().reset();
    useEngineeringMapStore().reset();
    useMasteryStore().reset();
    useOnboardingStore().reset();
    useTutorStore().reset();
    if (app.view === 'execution') await app.navigate('queue');
    return true;
  };

  // Lists running work and asks before cancelling it. True to go ahead.
  const confirmCancel = async () => {
    const busy = await call(window.taskpilot.repositories.busy());
    if (busy.length === 0) return true;
    const lines = busy.map((run) => `${BUSY_LABELS[run.kind]}：${runLabel(run)}`).join('；');
    return confirmAction({
      title: '切换仓库会取消正在运行的任务',
      body: `${lines}。被取消的任务会标为已取消，回到这个仓库后可以重试。`,
      accept: '取消任务并切换',
      danger: true,
    });
  };

  // Shared by switch and add: confirm, cancel, then reload. False when the
  // user backed out or the main process refused.
  const runSwitch = async (action: () => Promise<envelopeTypes.IpcResult<repositoryTypes.RepositoryList>>) => {
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

  // A switch made by another action, such as creating a lab repository,
  // which opens the new repository itself. Resolves to the action's result,
  // or null when the user backed out or it failed.
  const switchWith = async <T>(action: () => Promise<T>, failure: string): Promise<T | null> => {
    if (switching.value) return null;
    switching.value = true;
    try {
      if (!(await confirmCancel()) || !(await leaveCurrent())) return null;
      const result = await action();
      apply(await call(window.taskpilot.repositories.list()));
      await reloadAll();
      return result;
    } catch (error) {
      console.error('[repositories] switch failed', error);
      showToast(`${failure}：${describeError(error)}`);
      // The action may have switched before failing; show where things are.
      await refresh();
      return null;
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

  // Picks a folder and registers it. The first repository opens; later
  // ones are only listed, so adding never pulls the developer away from the
  // project in front of them (the sidebar lists it to switch to).
  const add = async () => {
    const root = await pickFolder();
    if (!root) return false;
    if (!currentId.value) {
      const added = await runSwitch(() => window.taskpilot.repositories.add(root, true));
      if (added) showToast(`已添加并打开 ${current.value?.name ?? '仓库'}`);
      return added;
    }
    try {
      const before = new Set(repositories.value.map((repo) => repo.id));
      apply(await call(window.taskpilot.repositories.add(root, false)));
      const added = repositories.value.find((repo) => !before.has(repo.id));
      showToast(added ? `已添加 ${added.name}，在侧栏「项目」里点它就能切换。` : '这个仓库已经在列表里了。');
      return true;
    } catch (error) {
      console.error('[repositories] add failed', error);
      showToast(`添加仓库失败：${describeError(error)}`);
      return false;
    }
  };

  // ========== Lab repository ==========
  // Writes a course's lab whose self-check passed into its lab repository.
  // The first one asks for an empty folder, creates the repository there and
  // switches to it like any switch; later ones are added to the open one.
  const placeLab = async (item: requirementTypes.Requirement) => {
    const requirements = useRequirementsStore();
    if (item.course?.repositoryId) return requirements.addLab(item);
    const root = await pickFolder();
    if (!root) return false;
    const placed = await switchWith(() => call(window.taskpilot.requirements.labPlace(item.id, root)), '创建实验仓库失败');
    if (!placed) return false;
    showToast('实验仓库建好了，第一个 lab 已经在工作队列里。');
    return true;
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
    switchWith,
    // Adding and relocating
    add,
    relocate,
    // Lab repository
    placeLab,
  };
});
