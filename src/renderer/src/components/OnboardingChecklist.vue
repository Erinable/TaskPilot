<script setup lang="ts">
// The getting-started checklist at the top of the queue follows the user's
// goal. Learning starts with a Tutor interview and needs no existing project.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { storeToRefs } from 'pinia';

import AppIcon from '@/components/AppIcon.vue';
import { showToast } from '@/lib/feedback.ts';
import * as onboarding from '@/lib/onboarding.ts';
import { useAppStore } from '@/stores/app.ts';
import { useOnboardingStore } from '@/stores/onboarding.ts';
import { useRepositoriesStore } from '@/stores/repositories.ts';
import { useRequirementsStore } from '@/stores/requirements.ts';
import { useSettingsStore } from '@/stores/settings.ts';

const app = useAppStore();
const repositories = useRepositoriesStore();
const requirements = useRequirementsStore();
const settings = useSettingsStore();
const checks = useOnboardingStore();
const { agent, checksReady, checking, loadError, path } = storeToRefs(checks);
const recheck = () => checks.recheck();
const shownCommand = ref<onboarding.OnboardingStepId | null>(null);
const paths: { id: onboarding.OnboardingPath; label: string }[] = [
  { id: 'project', label: '做项目' },
  { id: 'course', label: '学编程' },
];

const steps = computed(() =>
  onboarding.buildSteps({
    agent: agent.value,
    workspace: app.workspaceInfo,
    checksReady: checksReady.value,
    requirementCount: requirements.items.filter((item) => item.kind !== 'course').length,
    courseRequirementCount: requirements.items.filter((item) => item.kind === 'course').length,
    path: path.value,
  }),
);
const loaded = computed(() => agent.value !== null && checksReady.value !== null);
const visible = computed(() => loadError.value !== null || (loaded.value && !onboarding.isComplete(steps.value)));
const required = computed(() => steps.value.filter((step) => !step.optional));
const doneCount = computed(() => required.value.filter((step) => step.done).length);
const nextId = computed(() => required.value.find((step) => !step.done)?.id ?? null);

const copyCommand = async (command: string) => {
  try {
    await navigator.clipboard.writeText(command);
    showToast('已复制命令');
  } catch (error) {
    console.error('[onboarding] clipboard failed', error);
    showToast('复制失败：系统剪贴板不可用', 'error');
  }
};

const run = async (id: onboarding.OnboardingStepId) => {
  if (id === 'cli' || id === 'coding') shownCommand.value = shownCommand.value === id ? null : id;
  else if (id === 'repository') {
    if (await repositories.add()) await recheck();
  } else if (id === 'checks') await settings.open('commands');
  else await requirements.open({ compose: path.value });
};

onMounted(() => checks.start());
onBeforeUnmount(() => checks.stop());
</script>

<template>
  <section v-if="visible" class="onboarding panel glass" aria-labelledby="onboardingTitle" data-onboarding>
    <div class="panel-heading">
      <div>
        <h2 id="onboardingTitle">开始使用 TaskPilot</h2>
        <p>
          {{ path === 'course' ? '从学习目标开始，Tutor 会带你规划路径、生成第一个 lab。' : '完成准备后，AI 团队会把你的项目想法拆成可以照着写的任务。' }}
          <template v-if="loaded">完成这 {{ required.length }} 步，已完成 {{ doneCount }} / {{ required.length }}</template>
        </p>
      </div>
      <button class="icon-button small" type="button" title="重新检查" aria-label="重新检查" :disabled="checking" @click="recheck">
        <AppIcon :name="checking ? 'spinner' : 'refresh'" :class="{ spin: checking }" />
      </button>
    </div>
    <div class="onboarding-paths" role="group" aria-label="开始使用的目标">
      <button
        v-for="option in paths"
        :key="option.id"
        :class="path === option.id ? 'primary-button small' : 'secondary-button small'"
        type="button"
        :aria-pressed="path === option.id"
        :data-onboarding-path="option.id"
        @click="checks.choosePath(option.id)"
      >
        {{ option.label }}
      </button>
    </div>
    <div v-if="loadError" class="req-warning onboarding-error" role="alert">
      <AppIcon name="alert" />
      <div>
        <strong>{{ loadError }}</strong>
        <p>无法确认 CLI 和检查步骤是否已就绪。请重新检查；如果仍然失败，可以到「运行环境」检查 PATH 配置。</p>
        <button class="secondary-button small" type="button" data-action="retry-onboarding" :disabled="checking" @click="recheck">
          <AppIcon :name="checking ? 'spinner' : 'refresh'" :class="{ spin: checking }" />
          {{ checking ? '正在检查…' : '重新检查' }}
        </button>
      </div>
    </div>
    <ol v-if="loaded" class="onboarding-steps">
      <li
        v-for="step in steps"
        :key="step.id"
        class="onboarding-step"
        :class="{ done: step.done, next: step.id === nextId, waiting: step.waiting && !step.done, optional: step.optional }"
        :data-step="step.id"
        :value="step.optional ? undefined : required.indexOf(step) + 1"
      >
        <span class="onboarding-mark" aria-hidden="true">
          <AppIcon v-if="step.done" name="check" />
          <AppIcon v-else-if="step.optional" :name="step.icon" />
          <template v-else>{{ required.indexOf(step) + 1 }}</template>
        </span>
        <div class="onboarding-body">
          <strong>
            {{ step.title }}
            <span v-if="step.done" class="visually-hidden">（已完成）</span>
          </strong>
          <p>{{ step.why }}</p>
          <div v-if="shownCommand === step.id && !step.done" class="onboarding-install">
            <template v-if="step.help">
              <div v-for="help in step.help" :key="help.role" class="onboarding-role-help">
                <strong>{{ help.role }} · {{ help.title }}</strong>
                <p>{{ help.detail }}</p>
                <p v-if="help.commands.length">在终端按顺序运行，完成后回来点「重新检查」。npm 安装命令需要 Node.js。</p>
                <div v-for="command in help.commands" :key="command" class="onboarding-command">
                  <code>{{ command }}</code>
                  <button class="secondary-button small" type="button" @click="copyCommand(command)">
                    <AppIcon name="copy" />
                    复制
                  </button>
                </div>
              </div>
              <div class="onboarding-runtime-actions">
                <button class="secondary-button small" type="button" @click="settings.open('agents')">模型与智能体</button>
                <button class="secondary-button small" type="button" @click="settings.open('environment')">运行环境</button>
              </div>
            </template>
            <template v-else-if="step.command">
              <p>在终端运行下面的命令，完成后回来点「重新检查」。npm 安装命令需要 Node.js。</p>
              <div class="onboarding-command">
                <code>{{ step.command }}</code>
                <button class="secondary-button small" type="button" @click="copyCommand(step.command)">
                  <AppIcon name="copy" />
                  复制
                </button>
              </div>
            </template>
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

<style scoped>
.onboarding-paths,
.onboarding-runtime-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-bottom: var(--space-4);
}
.onboarding-paths {
  margin-inline: var(--panel-pad);
}
.onboarding-body {
  min-width: 0;
}
.onboarding-role-help + .onboarding-role-help {
  margin-top: var(--space-4);
}
.onboarding-runtime-actions {
  margin-top: var(--space-3);
  margin-bottom: 0;
}
.onboarding-error {
  margin: 0 var(--panel-pad) var(--space-4);
}
</style>
