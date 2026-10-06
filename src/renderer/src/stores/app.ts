import { defineStore } from 'pinia';
import { ref } from 'vue';

import { call } from '@/lib/ipc.ts';
import { describeError } from '@/lib/errors.ts';
import type * as ipc from '@shared/ipc_types.ts';

export type ViewName = 'queue' | 'execution' | 'requirements' | 'settings';

export const useAppStore = defineStore('app', () => {
  // ========== Navigation ==========
  const view = ref<ViewName>('queue');
  // Set by the settings store: resolves true when it is fine to leave settings.
  let leaveGuard: () => Promise<boolean> = async () => true;

  const setLeaveGuard = (guard: () => Promise<boolean>) => { leaveGuard = guard; };

  // Leaving settings with unsaved edits asks first; resolves false to stay.
  const navigate = async (next: ViewName) => {
    if (view.value === 'settings' && next !== 'settings' && !(await leaveGuard())) return false;
    view.value = next;
    return true;
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

  return {
    // Navigation
    view, setLeaveGuard, navigate,
    // Preferences
    preferences, applyPreferences, loadPreferences,
    // Workspace
    workspaceInfo, workspaceError, refreshWorkspaceStatus,
  };
});
