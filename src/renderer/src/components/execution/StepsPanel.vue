<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import InlineCode from '@/components/InlineCode.vue';
import StepTutor from './StepTutor.vue';
import { useExecutionStore } from '@/stores/execution.ts';
import type * as packageTypes from '@shared/ipc/packages.ts';

// folded: starts with only the heading shown (a finished package's steps).
const props = defineProps<{ task: packageTypes.TaskView; folded?: boolean }>();
const open = ref(!props.folded);
watch(
  () => props.folded,
  (folded) => (open.value = !folded),
);

const execution = useExecutionStore();

const done = computed(() => new Set(props.task.completedSteps));
const aiPlan = computed(() => props.task.mode === 'ai' || (props.task.mode === null && !!props.task.codingRun));
// Progress only describes the human checklist, never the Coding Agent's work.
const claimed = computed(() => props.task.status === 'in_progress');
const progress = computed(() => `${props.task.steps.length ? (done.value.size / props.task.steps.length) * 100 : 0}%`);

const onToggle = (event: Event, index: number) => {
  const box = event.target as HTMLInputElement;
  // Revert the optimistic toggle when saving fails.
  execution
    .setStepDone(index, box.checked)
    .then((saved) => {
      if (!saved) box.checked = !box.checked;
    })
    .catch((error) => console.error(error));
};
</script>

<template>
  <section class="panel glass">
    <div class="panel-heading">
      <div class="panel-title">
        <span class="panel-icon"><AppIcon name="list-checks" /></span>
        <div>
          <h2>执行指令</h2>
          <p v-if="aiPlan">原计划 · {{ task.steps.length }} 个步骤</p>
          <p v-else>{{ done.size }} / {{ task.steps.length }} 已完成</p>
        </div>
      </div>
      <button class="link-button panel-fold-toggle" type="button" :aria-expanded="open" data-action="fold" @click="open = !open">
        <AppIcon :name="open ? 'chevron-down' : 'chevron-right'" />
        {{ open ? '收起' : '展开' }}
      </button>
    </div>
    <div v-if="!aiPlan" v-show="open" class="progress-track" aria-hidden="true"><span class="progress-fill" :style="{ width: progress }"></span></div>
    <ol v-show="open" class="step-list">
      <li v-for="(step, index) in task.steps" :key="index" class="step-item" :class="{ done: !aiPlan && done.has(index) }">
        <div v-if="aiPlan" class="plan-step">
          <span class="plan-index" aria-hidden="true">{{ index + 1 }}.</span>
          <span class="step-text"><InlineCode :text="step" /></span>
        </div>
        <!-- The native checkbox stays for keyboard and screen readers; .step-check is its visual stand-in. -->
        <label v-else>
          <input type="checkbox" :checked="done.has(index)" :disabled="!claimed" :data-step-index="index" @change="onToggle($event, index)" />
          <span class="step-check"><AppIcon name="check" /></span>
          <span class="step-text"><InlineCode :text="step" /></span>
        </label>
        <StepTutor v-if="claimed && (aiPlan || !done.has(index))" :task-id="task.id" :step-index="index" />
      </li>
    </ol>
  </section>
</template>

<style scoped>
.plan-step {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 10px 8px;
  color: var(--text-secondary);
  font-size: var(--text-sm);
  line-height: 1.65;
}
.plan-index {
  flex: 0 0 20px;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}
</style>
