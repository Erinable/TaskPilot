<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import AcceptancePanel from '@/components/execution/AcceptancePanel.vue';
import DeviationDialog from '@/components/execution/DeviationDialog.vue';
import DeviationPanel from '@/components/execution/DeviationPanel.vue';
import DiffPanel from '@/components/execution/DiffPanel.vue';
import ReviewPanel from '@/components/execution/ReviewPanel.vue';
import ScopePanel from '@/components/execution/ScopePanel.vue';
import StepsPanel from '@/components/execution/StepsPanel.vue';
import VerifyPanel from '@/components/execution/VerifyPanel.vue';
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
const actionClass = (action: (typeof ACTIONS)[number]) => (action.primary ? 'primary-button' : `secondary-button${action.danger ? ' danger' : ''}`);

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
            <span>{{ task.baseline ? `基线 ${task.baseline.slice(0, 8)}` : '未领取' }}</span>
          </span>
        </div>
      </div>

      <div class="exec-actions">
        <button
          v-for="action in actions"
          :key="action.name"
          :class="actionClass(action)"
          type="button"
          :data-transition="action.name"
          :disabled="execution.transitioning !== null"
          :aria-busy="execution.transitioning === action.name"
          @click="transition(action.name)"
        >
          <AppIcon v-if="execution.transitioning === action.name" name="spinner" class="spin" />
          <AppIcon v-else :name="action.icon" />
          {{ action.label }}
        </button>
      </div>
      <div v-if="actions.length === 0" class="exec-notice">
        <AppIcon name="info" />
        <span>当前状态「{{ task.statusLabel }}」由 AI 团队推进，你无需操作。</span>
      </div>

      <div class="exec-columns">
        <div class="exec-column">
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
