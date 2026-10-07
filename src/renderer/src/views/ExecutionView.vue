<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import AcceptancePanel from '@/components/execution/AcceptancePanel.vue';
import CommitPanel from '@/components/execution/CommitPanel.vue';
import DeviationDialog from '@/components/execution/DeviationDialog.vue';
import DeviationPanel from '@/components/execution/DeviationPanel.vue';
import DiffPanel from '@/components/execution/DiffPanel.vue';
import ReviewPanel from '@/components/execution/ReviewPanel.vue';
import ScopePanel from '@/components/execution/ScopePanel.vue';
import StepsPanel from '@/components/execution/StepsPanel.vue';
import VerifyPanel from '@/components/execution/VerifyPanel.vue';
import TermHint from '@/components/TermHint.vue';
import { nextStep } from '@/lib/next_step.ts';
import { useAppStore } from '@/stores/app.ts';
import { ACTIONS, useExecutionStore } from '@/stores/execution.ts';
import type * as ipc from '@shared/ipc_types.ts';

const PRIORITY_LABELS: Record<ipc.Priority, string> = { high: '高优先级', medium: '中优先级', low: '低优先级' };

const app = useAppStore();
const execution = useExecutionStore();
const backButton = ref<HTMLButtonElement | null>(null);

const task = computed(() => execution.current);
const actions = computed(() => {
  const allowed = new Set(task.value?.humanTransitions ?? []);
  return ACTIONS.filter((action) => allowed.has(action.name));
});
const advice = computed(() => (task.value ? nextStep(task.value) : null));
// The advised action is the main button; the rest wait under "more". While
// steps remain, the advice is to write code, so no button leads.
const leading = computed(() => actions.value.find((action) => action.name === advice.value?.action) ?? null);
const others = computed(() => actions.value.filter((action) => action !== leading.value));

const back = () => {
  app
    .navigate('queue')
    .then((left) => left && execution.close())
    .catch((error) => console.error(error));
};
const transition = (name: ipc.HumanTransition) => {
  execution.runTransition(name).catch((error) => console.error(error));
};

onMounted(() => backButton.value?.focus());
// Leaving the view any way (back, sidebar, settings) stops the polls.
onBeforeUnmount(() => execution.close());
</script>

<template>
  <div class="view">
    <button ref="backButton" class="back-button" type="button" @click="back">
      <AppIcon name="arrow-left" />
      返回工作队列
    </button>

    <template v-if="task">
      <div class="exec-heading">
        <div class="exec-title-row">
          <span class="status-badge status-pill" :class="task.status">{{ task.statusLabel }}</span>
          <h1>{{ task.title }}</h1>
        </div>
        <p>{{ task.intro }}</p>
        <div class="exec-meta">
          <span class="meta-chip">
            <span class="priority-dot" :class="task.priority"></span>
            <span>{{ PRIORITY_LABELS[task.priority] }}</span>
          </span>
          <span class="meta-chip">
            <AppIcon name="folder" />
            <span>{{ task.module }} 模块</span>
          </span>
          <span class="meta-chip">
            <AppIcon name="clock" />
            <span>{{ task.estimate }}</span>
          </span>
          <span class="meta-chip">
            <AppIcon name="commit" />
            <TermHint v-if="task.baseline" term="baseline">基线 {{ task.baseline.slice(0, 8) }}</TermHint>
            <span v-else>未领取</span>
          </span>
        </div>
      </div>

      <div v-if="advice?.text" class="next-step" role="status" data-next-step>
        <AppIcon name="sparkle" />
        <div>
          <strong>下一步</strong>
          <p>{{ advice.text }}</p>
        </div>
      </div>
      <div class="exec-actions">
        <button
          v-if="leading"
          :class="leading.danger ? 'secondary-button danger' : 'primary-button'"
          type="button"
          :data-transition="leading.name"
          :disabled="execution.transitioning !== null"
          :aria-busy="execution.transitioning === leading.name"
          @click="transition(leading.name)"
        >
          <AppIcon v-if="execution.transitioning === leading.name" name="spinner" class="spin" />
          <AppIcon v-else :name="leading.icon" />
          {{ leading.label }}
        </button>
        <el-dropdown v-if="others.length" trigger="click" @command="transition">
          <button class="secondary-button" type="button" data-action="more-transitions" :disabled="execution.transitioning !== null">
            <AppIcon name="more" />
            更多操作
          </button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item
                v-for="action in others"
                :key="action.name"
                :command="action.name"
                :data-transition="action.name"
                :class="{ danger: action.danger }"
              >
                <AppIcon :name="action.icon" />
                {{ action.label }}
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>

      <div class="exec-columns">
        <div class="exec-column">
          <!-- Accepted work goes into git before the next package starts. -->
          <CommitPanel v-if="task.status === 'accepting' || task.status === 'done'" :task="task" />
          <ReviewPanel v-if="task.review" :task="task" :review="task.review" />
          <StepsPanel :task="task" />
          <AcceptancePanel :task="task" />
          <DeviationPanel :task="task" />
        </div>
        <div class="exec-column">
          <ScopePanel :task="task" />
          <VerifyPanel :task="task" />
          <DiffPanel :task="task" />
        </div>
      </div>

      <DeviationDialog :task="task" />
    </template>
  </div>
</template>
