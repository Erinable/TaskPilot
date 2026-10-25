<script setup lang="ts">
import { computed } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import DifficultyChip from '@/components/DifficultyChip.vue';
import { actionOf, flagsOf, timeText } from '@/lib/board.ts';
import { useExecutionStore } from '@/stores/execution.ts';
import type { IconName } from '@/lib/icons.ts';
import type * as packageTypes from '@shared/ipc/packages.ts';

const props = defineProps<{ task: packageTypes.TaskView }>();
const execution = useExecutionStore();

const action = computed(() => actionOf(props.task));
const flags = computed(() => flagsOf(props.task));
const time = computed(() => timeText(props.task));
const progress = computed(() =>
  props.task.steps.length && props.task.status !== 'pending' ? props.task.completedSteps.length / props.task.steps.length : null,
);

// The card opens the package; its button does the column's next step.
const open = () => execution.open(props.task.id).catch((error) => console.error(error));
const act = () => {
  if (action.value.kind === 'claim') execution.claimFromQueue(props.task.id).catch((error) => console.error(error));
  else open();
};
</script>

<template>
  <article class="board-card" :class="{ waiting: action.kind === 'wait' }" :data-package="task.id">
    <button class="board-card-open" type="button" :aria-label="`打开 ${task.title}`" @click="open">
      <span class="board-card-head">
        <span class="board-card-icon" :class="`priority-${task.priority}`"><AppIcon :name="task.icon as IconName" /></span>
        <span class="board-card-title">{{ task.title }}</span>
      </span>
      <span class="board-card-meta">
        <span class="priority-dot" :class="task.priority" :title="task.priority"></span>
        <span
          v-if="time"
          class="board-card-time"
          :class="{ overrun: time.overrun }"
          :title="time.overrun ? '比预计多用了一半以上' : '从开始到完成，含中间休息'"
        >
          {{ time.text }}
        </span>
        <span v-else class="board-card-time">{{ task.estimate }}</span>
        <DifficultyChip :difficulty="task.difficulty" />
      </span>
      <span v-if="progress !== null && task.status !== 'done'" class="board-card-progress" aria-hidden="true">
        <span :style="{ width: `${progress * 100}%` }"></span>
      </span>
    </button>
    <ul v-if="flags.length" class="board-card-flags">
      <li v-for="flag in flags" :key="flag.text" :class="flag.tone">{{ flag.text }}</li>
    </ul>
    <div class="board-card-action">
      <span v-if="action.kind === 'wait'" class="board-card-wait">
        <AppIcon :name="task.status === 'pending' ? 'clock' : 'spinner'" :class="{ spin: task.status !== 'pending' }" />
        {{ action.label }}
      </span>
      <!-- A done card has nothing left to do; the card itself opens it. -->
      <button
        v-else-if="task.status !== 'done'"
        :class="action.kind === 'claim' || action.kind === 'accept' ? 'primary-button small' : 'secondary-button small'"
        type="button"
        @click="act"
      >
        {{ action.label }}
      </button>
    </div>
  </article>
</template>

<style scoped>
.board-card {
  display: grid;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-md);
  background: var(--glass-bg-strong);
  transition:
    border-color 0.15s,
    box-shadow 0.15s;
}
.board-card:hover,
.board-card:focus-within {
  border-color: var(--glass-edge);
  box-shadow: 0 4px 14px -8px rgba(0, 0, 0, 0.35);
}
.board-card.waiting {
  opacity: 0.8;
}
.board-card-open {
  display: grid;
  gap: var(--space-2);
  padding: 0;
  border: 0;
  background: none;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.board-card-open:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 4px;
  border-radius: var(--radius-sm);
}
.board-card-head {
  display: flex;
  gap: var(--space-2);
  align-items: flex-start;
}
.board-card-icon {
  display: grid;
  flex: none;
  place-items: center;
  width: 24px;
  height: 24px;
  border-radius: var(--radius-sm);
  color: var(--accent);
  background: var(--accent-soft);
}
.board-card-icon .icon {
  width: 14px;
  height: 14px;
}
.board-card-title {
  color: var(--text);
  font-size: var(--text-md);
  font-weight: 600;
  line-height: 1.4;
}
.board-card-meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  align-items: center;
  color: var(--text-tertiary);
  font-size: var(--text-xs);
}
.board-card-time.overrun {
  color: var(--warning);
  font-weight: 600;
}
.board-card-progress {
  height: 3px;
  overflow: hidden;
  border-radius: 2px;
  background: var(--fill);
}
.board-card-progress span {
  display: block;
  height: 100%;
  background: var(--accent);
}
.board-card-flags {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: var(--text-xs);
}
.board-card-flags li {
  padding: 1px 6px;
  border-radius: var(--radius-sm);
  background: var(--fill);
}
.board-card-flags .warning {
  color: var(--warning);
}
.board-card-flags .danger {
  color: var(--danger);
}
.board-card-flags .info {
  color: var(--text-secondary);
}
.board-card-action {
  display: flex;
  justify-content: flex-end;
}
.board-card-wait {
  display: inline-flex;
  gap: var(--space-1);
  align-items: center;
  color: var(--text-tertiary);
  font-size: var(--text-xs);
}
.board-card-wait .icon {
  width: 13px;
  height: 13px;
}
</style>
