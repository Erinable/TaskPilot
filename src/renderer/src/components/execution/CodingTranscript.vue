<script setup lang="ts">
import type * as codingTypes from '@shared/coding_types.ts';

const props = defineProps<{ events: codingTypes.CodingEvent[] }>();

// The transcript in plain words; the CLI's raw event kinds mean nothing to a beginner.
const EVENT_LABELS: Record<codingTypes.CodingEvent['type'], string> = {
  status: '进度',
  text: '说明',
  thinking: '思考',
  tool: '操作',
  error: '出错',
};
</script>

<template>
  <div class="coding-transcript" aria-live="polite" aria-label="编码 Agent 实时记录">
    <div v-if="props.events.length === 0" class="empty-hint">等待编码 Agent 输出…</div>
    <div v-for="event in props.events" :key="event.sequence" class="coding-event">
      <time>{{ new Date(event.at).toLocaleTimeString() }}</time>
      <strong :class="event.type">{{ EVENT_LABELS[event.type] }}</strong>
      <span>{{ event.text }}</span>
    </div>
  </div>
</template>

<style scoped>
.coding-transcript {
  max-height: 220px;
  overflow: auto;
  padding: 10px;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-md);
  background: var(--fill);
  font: var(--text-xs) var(--font-mono);
}
.coding-event {
  display: grid;
  grid-template-columns: 72px 54px 1fr;
  gap: 8px;
  padding: 3px 0;
}
.coding-event time,
.coding-event strong {
  color: var(--text-tertiary);
}
.coding-event strong.error {
  color: var(--danger);
}
.coding-event strong.tool {
  color: var(--accent);
}
.coding-event span {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
