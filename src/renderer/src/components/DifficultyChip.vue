<script setup lang="ts">
// How hard a package is for a beginner. The reason shows on hover and, with
// `detailed`, as a line of text under the chip. Packages planned before
// difficulty existed have none and render nothing.
import type * as packageTypes from '@shared/ipc/packages.ts';

const LABELS: Record<packageTypes.Difficulty, string> = { easy: '入门', medium: '适中', hard: '有挑战' };
// Filled bars out of three, like a signal meter.
const BARS: Record<packageTypes.Difficulty, number> = { easy: 1, medium: 2, hard: 3 };

defineProps<{ difficulty?: packageTypes.PackageDifficulty; detailed?: boolean }>();
</script>

<template>
  <span v-if="difficulty" class="difficulty" :class="{ detailed }">
    <span class="difficulty-chip" :class="difficulty.level" :title="detailed ? undefined : `难度：${difficulty.reason}`">
      <span class="difficulty-bars" aria-hidden="true">
        <span v-for="bar in 3" :key="bar" :class="{ on: bar <= BARS[difficulty.level] }"></span>
      </span>
      难度{{ LABELS[difficulty.level] }}
    </span>
    <small v-if="detailed" class="difficulty-reason">{{ difficulty.reason }}</small>
  </span>
</template>

<style scoped>
.difficulty {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}
.difficulty.detailed {
  display: flex;
  flex-wrap: wrap;
}
.difficulty-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 8px;
  border-radius: var(--radius-sm);
  font-size: var(--text-xs);
  font-weight: 600;
  white-space: nowrap;
}
.difficulty-chip.easy {
  color: var(--success);
  background: var(--success-soft);
}
.difficulty-chip.medium {
  color: var(--warning);
  background: var(--warning-soft);
}
.difficulty-chip.hard {
  color: var(--danger);
  background: var(--danger-soft);
}
.difficulty-bars {
  display: inline-flex;
  align-items: flex-end;
  gap: 2px;
  height: 10px;
}
.difficulty-bars span {
  width: 3px;
  border-radius: 1px;
  background: currentColor;
  opacity: 0.25;
}
.difficulty-bars span:nth-child(1) {
  height: 4px;
}
.difficulty-bars span:nth-child(2) {
  height: 7px;
}
.difficulty-bars span:nth-child(3) {
  height: 10px;
}
.difficulty-bars span.on {
  opacity: 1;
}
.difficulty-reason {
  color: var(--text-tertiary);
  font-size: var(--text-xs);
}
</style>
