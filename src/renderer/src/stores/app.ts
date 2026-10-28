import { defineStore } from 'pinia';
import { ref } from 'vue';

import { call } from '@/lib/ipc.ts';
import { describeError } from '@/lib/errors.ts';
import * as layout from '@/lib/sidebar_layout.ts';
import type * as activityTypes from '@shared/ipc/activity.ts';
import type * as settingsTypes from '@shared/ipc/settings.ts';
import type * as workspaceTypes from '@shared/ipc/workspace.ts';
import { useRepositoryIdentityStore } from './repository_identity.ts';
import { createStateWatcher } from './state_watcher.ts';

export type ViewName =
  'queue' | 'execution' | 'requirements' | 'settings' | 'map' | 'activity' | 'release' | 'team' | 'costs' | 'notes' | 'mastery' | 'courses';

export const SIDEBAR_STORAGE_KEY = 'taskpilot.sidebar.collapsed';
export const SIDEBAR_WIDTH_STORAGE_KEY = 'taskpilot.sidebar.width';

export const useAppStore = defineStore('app', () => {
  const repository = useRepositoryIdentityStore();
  // ========== Navigation ==========
  const view = ref<ViewName>('queue');
  // Set by the settings store: resolves true when it is fine to leave settings.
  let leaveGuard: () => Promise<boolean> = async () => true;

  const setLeaveGuard = (guard: () => Promise<boolean>) => {
    leaveGuard = guard;
  };

  // Settings with unsaved edits ask first; resolves false to stay. Also used
  // before a repository switch, which leaves settings in place.
  const confirmLeaveSettings = () => (view.value === 'settings' ? leaveGuard() : Promise.resolve(true));

  // Leaving settings with unsaved edits asks first; resolves false to stay.
  const navigate = async (next: ViewName) => {
    if (view.value === 'settings' && next !== 'settings' && !(await leaveGuard())) return false;
    view.value = next;
    return true;
  };

  // ========== Layout ==========
  // A per-machine layout choice; storage that is missing or unreadable means expanded.
  const sidebarCollapsed = ref(false);
  try {
    sidebarCollapsed.value = globalThis.localStorage?.getItem(SIDEBAR_STORAGE_KEY) === 'true';
  } catch {
    // Keep the default.
  }

  // Dragged by its edge; the width is stored per machine like the collapse.
  const sidebarWidth = ref(layout.DEFAULT_SIDEBAR_WIDTH);
  try {
    sidebarWidth.value = layout.storedSidebarWidth(globalThis.localStorage?.getItem(SIDEBAR_WIDTH_STORAGE_KEY) ?? null);
  } catch {
    // Keep the default.
  }

  const saveSidebarLayout = () => {
    try {
      localStorage.setItem(SIDEBAR_STORAGE_KEY, String(sidebarCollapsed.value));
      localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidth.value));
    } catch (error) {
      console.error('[app] sidebar state not saved', error);
    }
  };

  // While dragging: a width under the collapse threshold folds the sidebar
  // to its icon rail; pulling it back out opens it again.
  const resizeSidebar = (requested: number) => {
    const next = layout.dragSidebar(requested);
    sidebarCollapsed.value = next.collapsed;
    if (next.width !== null) sidebarWidth.value = next.width;
  };
  const resetSidebarWidth = () => {
    sidebarCollapsed.value = false;
    sidebarWidth.value = layout.DEFAULT_SIDEBAR_WIDTH;
    saveSidebarLayout();
  };

  const toggleSidebar = () => {
    sidebarCollapsed.value = !sidebarCollapsed.value;
    try {
      localStorage.setItem(SIDEBAR_STORAGE_KEY, String(sidebarCollapsed.value));
    } catch (error) {
      console.error('[app] sidebar state not saved', error);
    }
  };

  // ========== Preferences ==========
  const preferences = ref<settingsTypes.Preferences | null>(null);

  // The main process sets nativeTheme.themeSource, which drives the CSS
  // colour scheme; the page only needs to know about vibrancy.
  const applyPreferences = (next: settingsTypes.Preferences) => {
    preferences.value = next;
    document.body.classList.toggle('vibrancy', next.appearance.vibrancy && /mac/i.test(navigator.platform));
  };

  const loadPreferences = async () => applyPreferences(await call(window.taskpilot.preferences.get()));

  // ========== Workspace ==========
  const workspaceInfo = ref<workspaceTypes.WorkspaceInfo | null>(null);
  const workspaceError = ref<string | null>(null);
  let workspaceGeneration = 0;

  const refreshWorkspaceStatus = async () => {
    const token = ++workspaceGeneration;
    const repositoryId = repository.currentId;
    try {
      const next = await call(window.taskpilot.workspace.info());
      if (token !== workspaceGeneration || repositoryId !== repository.currentId) return workspaceInfo.value;
      workspaceInfo.value = next;
      workspaceError.value = null;
    } catch (error) {
      if (token !== workspaceGeneration || repositoryId !== repository.currentId) return workspaceInfo.value;
      // A configured root that has since vanished or broken lands here.
      console.error('Failed to read workspace info', error);
      workspaceInfo.value = null;
      workspaceError.value = describeError(error);
    }
    return workspaceInfo.value;
  };

  // Activity is pushed by the main process; keep one serialized read so a
  // notification arriving during a read is handled immediately afterwards.
  const activity = ref<activityTypes.ActivityOverview | null>(null);
  const activityWatcher = createStateWatcher({
    name: 'activity',
    domains: ['activity', 'coding', 'packages', 'requirements'],
    read: async (isCurrent) => {
      const repositoryId = repository.currentId;
      try {
        const next = await call(window.taskpilot.activity.overview());
        if (isCurrent() && repositoryId === repository.currentId) activity.value = next;
      } catch (error) {
        console.error('[activity] overview failed', error);
      }
    },
  });
  // Workspace status shares the activity lifetime but has its own read.
  const workspaceWatcher = createStateWatcher({
    name: 'workspace',
    domains: ['workspace'],
    initialRead: false,
    read: async () => {
      await refreshWorkspaceStatus();
    },
  });
  const refreshActivity = () => activityWatcher.refresh();

  const startActivity = () => {
    workspaceWatcher.start().catch((error) => console.error(error));
    activityWatcher.start().catch((error) => console.error(error));
  };

  const stopActivity = () => {
    workspaceWatcher.stop();
    activityWatcher.stop();
  };

  return {
    // Navigation
    view,
    setLeaveGuard,
    confirmLeaveSettings,
    navigate,
    // Layout
    sidebarCollapsed,
    sidebarWidth,
    resizeSidebar,
    resetSidebarWidth,
    saveSidebarLayout,
    toggleSidebar,
    // Preferences
    preferences,
    applyPreferences,
    loadPreferences,
    // Workspace
    workspaceInfo,
    workspaceError,
    refreshWorkspaceStatus,
    // Activity
    activity,
    refreshActivity,
    startActivity,
    stopActivity,
  };
});
