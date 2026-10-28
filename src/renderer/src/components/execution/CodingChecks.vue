<script setup lang="ts">
import { stepLabel } from '@/lib/check_steps.ts';
import type * as workspaceTypes from '@shared/ipc/workspace.ts';

const props = defineProps<{
  checks: { kind: workspaceTypes.CheckKind; check: workspaceTypes.CheckRun }[];
}>();
</script>

<template>
  <div v-if="props.checks.length" class="coding-checks" aria-label="编码前置检查">
    <strong>前置检查</strong>
    <div v-for="entry in props.checks" :key="entry.kind">
      <span>{{ stepLabel(entry.kind) }}</span>
      <span :class="entry.check.summary.ok ? 'check-pass' : 'check-fail'">{{ entry.check.summary.ok ? '通过' : '失败' }}</span>
    </div>
  </div>
</template>

<style scoped>
.coding-checks {
  display: grid;
  gap: 8px;
}
.coding-checks > div {
  display: flex;
  justify-content: space-between;
  gap: 10px;
}
.check-pass {
  color: var(--online);
}
.check-fail {
  color: var(--danger);
}
</style>
