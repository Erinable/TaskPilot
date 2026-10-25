// What the getting-started checklist needs beyond the queue's stores: the
// analysis CLI's status and the configured test command. Cleared on a
// repository switch, so the checklist hides until the new answers arrive.
import { defineStore } from 'pinia';
import { ref } from 'vue';

import { call } from '@/lib/ipc.ts';
import type * as settingsTypes from '@shared/ipc/settings.ts';

export const useOnboardingStore = defineStore('onboarding', () => {
  // ========== Checks ==========
  const agent = ref<settingsTypes.AgentStatus | null>(null);
  const testCommand = ref<string | null>(null);
  const checking = ref(false);
  let session = 0;

  const recheck = async () => {
    const opened = session;
    checking.value = true;
    try {
      const [status, view] = await Promise.all([call(window.taskpilot.agent.status()), call(window.taskpilot.workspace.get())]);
      if (opened !== session) return;
      agent.value = status;
      testCommand.value = view.lines.test;
    } catch (error) {
      console.error('[onboarding] recheck failed', error);
    } finally {
      if (opened === session) checking.value = false;
    }
  };

  const reset = () => {
    session += 1;
    agent.value = null;
    testCommand.value = null;
    checking.value = false;
  };

  return {
    // Checks
    agent,
    testCommand,
    checking,
    recheck,
    reset,
  };
});
