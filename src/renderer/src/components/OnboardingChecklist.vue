<script setup lang="ts">
// The getting-started checklist at the top of the queue. It disappears once
// every step is done, and each step explains itself in plain words.
import { computed, onMounted, ref } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import { call } from '@/lib/ipc.ts';
import { showToast } from '@/lib/feedback.ts';
import * as onboarding from '@/lib/onboarding.ts';
import { useAppStore } from '@/stores/app.ts';
import { useRepositoriesStore } from '@/stores/repositories.ts';
import { useRequirementsStore } from '@/stores/requirements.ts';
import { useSettingsStore } from '@/stores/settings.ts';
import type * as ipc from '@shared/ipc_types.ts';

const INSTALL_COMMAND = 'npm install -g @anthropic-ai/claude-code';

const app = useAppStore();
const repositories = useRepositoriesStore();
const requirements = useRequirementsStore();
const settings = useSettingsStore();

const agent = ref<ipc.AgentStatus | null>(null);
const testCommand = ref<string | null>(null);
const checking = ref(false);
const showInstall = ref(false);

// The CLI and the test command are not in any store the queue reads.
const recheck = async () => {
  checking.value = true;
  try {
    const [status, view] = await Promise.all([call(window.taskpilot.agent.status()), call(window.taskpilot.workspace.get())]);
    agent.value = status;
    testCommand.value = view.lines.test;
  } catch (error) {
    console.error('[onboarding] recheck failed', error);
  } finally {
    checking.value = false;
  }
};

const steps = computed(() =>
  onboarding.buildSteps({ agent: agent.value, workspace: app.workspaceInfo, testCommand: testCommand.value, requirementCount: requirements.items.length }),
);
// Hidden until the first check answers, so it never flashes for a set-up user.
const visible = computed(() => agent.value !== null && testCommand.value !== null && !onboarding.isComplete(steps.value));
const doneCount = computed(() => steps.value.filter((step) => step.done).length);
// The first step not done is the one to do now.
const nextId = computed(() => steps.value.find((step) => !step.done)?.id ?? null);

const copyInstall = async () => {
  try {
    await navigator.clipboard.writeText(INSTALL_COMMAND);
    showToast('已复制安装命令');
  } catch (error) {
    console.error('[onboarding] clipboard failed', error);
    showToast('复制失败：系统剪贴板不可用', 'error');
  }
};

const run = async (id: onboarding.OnboardingStepId) => {
  if (id === 'cli') showInstall.value = !showInstall.value;
  else if (id === 'repository') {
    if (await repositories.add()) await recheck();
  } else if (id === 'checks') await settings.open('setup');
  else await requirements.open({ compose: true });
};

onMounted(() => recheck());
</script>

<template>
  <section v-if="visible" class="onboarding panel glass" aria-labelledby="onboardingTitle" data-onboarding>
    <div class="panel-heading">
      <div>
        <h2 id="onboardingTitle">开始使用 TaskPilot</h2>
        <p>完成这 {{ steps.length }} 步，AI 团队就能帮你把想法拆成可以照着写的任务。已完成 {{ doneCount }} / {{ steps.length }}</p>
      </div>
      <button class="icon-button small" type="button" title="重新检查" aria-label="重新检查" :disabled="checking" @click="recheck">
        <AppIcon :name="checking ? 'spinner' : 'refresh'" :class="{ spin: checking }" />
      </button>
    </div>
    <ol class="onboarding-steps">
      <li
        v-for="(step, index) in steps"
        :key="step.id"
        class="onboarding-step"
        :class="{ done: step.done, next: step.id === nextId, waiting: step.waiting && !step.done }"
        :data-step="step.id"
      >
        <span class="onboarding-mark" aria-hidden="true">
          <AppIcon v-if="step.done" name="check" />
          <template v-else>{{ index + 1 }}</template>
        </span>
        <div class="onboarding-body">
          <strong>
            {{ step.title }}
            <span v-if="step.done" class="visually-hidden">（已完成）</span>
          </strong>
          <p>{{ step.why }}</p>
          <div v-if="step.id === 'cli' && showInstall && !step.done" class="onboarding-install">
            <p>在终端里运行下面这行命令（需要先装好 Node.js），装好后回来点「重新检查」：</p>
            <div class="onboarding-command">
              <code>{{ INSTALL_COMMAND }}</code>
              <button class="secondary-button small" type="button" @click="copyInstall">
                <AppIcon name="copy" />
                复制
              </button>
            </div>
          </div>
        </div>
        <button
          v-if="!step.done"
          :class="step.id === nextId ? 'primary-button' : 'secondary-button'"
          type="button"
          :disabled="step.waiting"
          :title="step.waiting ? '先完成前面的步骤' : undefined"
          @click="run(step.id)"
        >
          {{ step.action }}
        </button>
      </li>
    </ol>
  </section>
</template>
