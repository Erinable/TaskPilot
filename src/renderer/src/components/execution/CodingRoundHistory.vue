<script setup lang="ts">
import type * as codingTypes from '@shared/coding_types.ts';

const props = defineProps<{
  run: codingTypes.CodingRun;
  statusLabels: Record<codingTypes.CodingRun['status'], string>;
  maxAutoAttempts: number;
}>();

const TRIGGER_LABELS: Record<codingTypes.CodingTrigger, string> = {
  human: '你发起',
  checks_failed: '检查失败后重试',
  qa_rejected: 'QA 驳回后重试',
};
</script>

<template>
  <div class="coding-rounds" aria-label="编码轮次">
    <strong>第 {{ props.run.attempt }} 轮（自动重试最多 {{ props.maxAutoAttempts }} 轮）</strong>
    <ol>
      <li v-for="round in props.run.rounds" :key="round.attempt">
        第 {{ round.attempt }} 轮 · {{ TRIGGER_LABELS[round.trigger] }} · {{ props.statusLabels[round.status] }} · {{ round.files }} 个文件
      </li>
      <li class="current">第 {{ props.run.attempt }} 轮 · {{ TRIGGER_LABELS[props.run.trigger] }} · {{ props.statusLabels[props.run.status] }}</li>
    </ol>
    <details v-if="props.run.feedback">
      <summary>这一轮交给 AI 的问题</summary>
      <pre class="coding-diff">{{ props.run.feedback }}</pre>
    </details>
  </div>
</template>

<style scoped>
.coding-rounds {
  font-size: var(--text-sm);
}
.coding-rounds ol {
  margin: 4px 0;
  padding-left: 20px;
  color: var(--text-secondary);
}
.coding-rounds .current {
  color: var(--text);
}
.coding-diff {
  max-height: 260px;
  overflow: auto;
  margin: 0;
  padding: 12px;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-md);
  background: var(--fill);
  color: var(--text-secondary);
  font: var(--text-xs) var(--font-mono);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
