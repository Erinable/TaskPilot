// The getting-started checks follow committed workspace and runtime changes.
// Repository switches invalidate in-flight reads; the goal stays per-machine.
import { defineStore } from 'pinia';
import { ref } from 'vue';

import { call } from '@/lib/ipc.ts';
import { describeError } from '@/lib/errors.ts';
import { hasBlockingChecks } from '@/lib/onboarding.ts';
import type { OnboardingPath } from '@/lib/onboarding.ts';
import { createStateWatcher } from './state_watcher.ts';
import type * as settingsTypes from '@shared/ipc/settings.ts';

const PATH_STORAGE_KEY = 'taskpilot.onboarding.path';

export const useOnboardingStore = defineStore('onboarding', () => {
  const agent = ref<settingsTypes.AgentStatus | null>(null);
  const checksReady = ref<boolean | null>(null);
  const checking = ref(false);
  const loadError = ref<string | null>(null);
  const path = ref<OnboardingPath>('project');
  try {
    if (globalThis.localStorage?.getItem(PATH_STORAGE_KEY) === 'course') path.value = 'course';
  } catch {
    // A missing convenience preference never blocks getting started.
  }

  const choosePath = (next: OnboardingPath) => {
    path.value = next;
    try {
      globalThis.localStorage?.setItem(PATH_STORAGE_KEY, next);
    } catch {
      // Keep the choice for this session when storage is unavailable.
    }
  };

  const watcher = createStateWatcher({
    name: 'onboarding',
    domains: ['preferences', 'workspace'],
    read: async (isCurrent) => {
      checking.value = true;
      try {
        const [status, view] = await Promise.all([call(window.taskpilot.agent.status()), call(window.taskpilot.workspace.get())]);
        if (!isCurrent()) return;
        agent.value = status;
        checksReady.value = hasBlockingChecks(view.steps);
        loadError.value = null;
      } catch (error) {
        if (!isCurrent()) return;
        loadError.value = `准备状态读取失败：${describeError(error)}`;
        console.error('[onboarding] recheck failed', error);
      } finally {
        if (isCurrent()) checking.value = false;
      }
    },
  });

  const stop = () => {
    watcher.stop();
    checking.value = false;
  };
  const reset = () => {
    watcher.invalidate();
    agent.value = null;
    checksReady.value = null;
    checking.value = false;
    loadError.value = null;
  };

  return { agent, checksReady, checking, loadError, path, choosePath, recheck: watcher.refresh, start: watcher.start, stop, reset };
});
