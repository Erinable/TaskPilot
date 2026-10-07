import { defineStore } from 'pinia';
import { ref } from 'vue';

import { call } from '@/lib/ipc.ts';
import { describeError } from '@/lib/errors.ts';
import type * as ipc from '@shared/ipc_types.ts';

export type ViewName = 'queue' | 'execution' | 'requirements' | 'settings' | 'map' | 'activity' | 'release' | 'team';

export const SIDEBAR_STORAGE_KEY = 'taskpilot.sidebar.collapsed';

export const useAppStore = defineStore('app', () => {
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

  const toggleSidebar = () => {
    sidebarCollapsed.value = !sidebarCollapsed.value;
    try {
      localStorage.setItem(SIDEBAR_STORAGE_KEY, String(sidebarCollapsed.value));
    } catch (error) {
      console.error('[app] sidebar state not saved', error);
    }
  };

  // ========== Preferences ==========
  const preferences = ref<ipc.Preferences | null>(null);

  // The main process sets nativeTheme.themeSource, which drives the CSS
  // colour scheme; the page only needs to know about vibrancy.
  const applyPreferences = (next: ipc.Preferences) => {
    preferences.value = next;
    document.body.classList.toggle('vibrancy', next.appearance.vibrancy && /mac/i.test(navigator.platform));
  };

  const loadPreferences = async () => applyPreferences(await call(window.taskpilot.preferences.get()));

  // ========== Workspace ==========
  const workspaceInfo = ref<ipc.WorkspaceInfo | null>(null);
  const workspaceError = ref<string | null>(null);

  const refreshWorkspaceStatus = async () => {
    try {
      workspaceInfo.value = await call(window.taskpilot.workspace.info());
      workspaceError.value = null;
    } catch (error) {
      // A configured root that has since vanished or broken lands here.
      console.error('Failed to read workspace info', error);
      workspaceInfo.value = null;
      workspaceError.value = describeError(error);
    }
    return workspaceInfo.value;
  };

  // ========== Activity ==========
  const activity = ref<ipc.ActivityOverview | null>(null);
  let activityTimer: number | null = null;

  // A failed read keeps the last overview; the feed is not worth a toast.
  const refreshActivity = async () => {
    try {
      activity.value = await call(window.taskpilot.activity.overview());
    } catch (error) {
      console.error('[activity] overview failed', error);
    }
  };

  // Agents run in the background, so presence and the feed are polled.
  const startActivityPolling = (intervalMs: number) => {
    if (activityTimer !== null) return;
    refreshActivity().catch((error) => console.error(error));
    activityTimer = window.setInterval(() => refreshActivity().catch((error) => console.error(error)), intervalMs);
  };

  const stopActivityPolling = () => {
    if (activityTimer !== null) window.clearInterval(activityTimer);
    activityTimer = null;
  };

  return {
    // Navigation
    view,
    setLeaveGuard,
    confirmLeaveSettings,
    navigate,
    // Layout
    sidebarCollapsed,
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
    startActivityPolling,
    stopActivityPolling,
  };
});
