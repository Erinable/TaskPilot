<script setup lang="ts">
import { computed } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import InlineCode from '@/components/InlineCode.vue';
import { useExecutionStore } from '@/stores/execution.ts';
import type * as ipc from '@shared/ipc_types.ts';

const props = defineProps<{ task: ipc.TaskView }>();

const execution = useExecutionStore();

const done = computed(() => new Set(props.task.completedSteps));
// Progress only makes sense while executing.
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
          <p>{{ done.size }} / {{ task.steps.length }} 已完成</p>
        </div>
      </div>
    </div>
    <div class="progress-track" aria-hidden="true"><span class="progress-fill" :style="{ width: progress }"></span></div>
    <ol class="step-list">
      <li v-for="(step, index) in task.steps" :key="index" class="step-item" :class="{ done: done.has(index) }">
        <!-- The native checkbox stays for keyboard and screen readers; .step-check is its visual stand-in. -->
        <label>
          <input type="checkbox" :checked="done.has(index)" :disabled="!claimed" :data-step-index="index" @change="onToggle($event, index)" />
          <span class="step-check"><AppIcon name="check" /></span>
          <span class="step-text"><InlineCode :text="step" /></span>
        </label>
      </li>
    </ol>
  </section>
</template>
