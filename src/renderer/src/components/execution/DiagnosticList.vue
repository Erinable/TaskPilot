<script setup lang="ts">
import { computed } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import { SEVERITY_LABELS, diagnosticPlace } from '@/lib/check_steps.ts';
import { openWorkspaceFile } from '@/lib/open_file.ts';
import type { Diagnostic } from '@shared/check_steps.ts';

// Findings from any step in one shape: where, how bad, what. The tool that
// produced them does not matter here. A finding with a file opens it at the
// line; the path is confined to the workspace by the main process.
const props = withDefaults(defineProps<{ items: Diagnostic[]; limit?: number }>(), { limit: 50 });

const shown = computed(() => props.items.slice(0, props.limit));
const hidden = computed(() => props.items.length - shown.value.length);
const icon = (item: Diagnostic) => (item.severity === 'error' ? 'x-circle' : item.severity === 'warning' ? 'alert' : 'info');
const open = (item: Diagnostic) => {
  if (item.file) openWorkspaceFile(item.file, item.line).catch((error) => console.error(error));
};
</script>

<template>
  <ul class="diagnostic-list" aria-label="检查结果">
    <li v-for="(item, index) in shown" :key="index" class="diagnostic" :class="item.severity">
      <AppIcon :name="icon(item)" />
      <span class="diagnostic-severity">{{ SEVERITY_LABELS[item.severity] }}</span>
      <button v-if="item.file" class="diagnostic-place" type="button" :title="`在编辑器中打开 ${diagnosticPlace(item)}`" @click="open(item)">
        {{ diagnosticPlace(item) }}
      </button>
      <span class="diagnostic-message">{{ item.message }}</span>
      <code v-if="item.rule" class="diagnostic-rule">{{ item.rule }}</code>
    </li>
    <li v-if="hidden > 0" class="diagnostic more">还有 {{ hidden }} 条，见下面的输出。</li>
  </ul>
</template>

<style scoped>
.diagnostic-list {
  display: grid;
  gap: var(--space-1);
  margin: 10px 0 0;
  padding: 0;
  list-style: none;
}
.diagnostic {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-2);
  padding: 7px 10px;
  border-radius: var(--radius-sm);
  font-size: var(--text-sm);
  overflow-wrap: anywhere;
}
.diagnostic.error {
  color: var(--danger);
  background: var(--danger-soft);
}
.diagnostic.warning {
  color: var(--warning);
  background: var(--warning-soft);
}
.diagnostic.info,
.diagnostic.more {
  color: var(--text-muted);
  background: var(--fill);
}
.diagnostic .icon {
  width: 13px;
  height: 13px;
  align-self: center;
}
.diagnostic-severity {
  font-weight: 700;
}
.diagnostic-place {
  padding: 0;
  color: inherit;
  background: none;
  border: 0;
  font: var(--text-sm) var(--font-mono);
  text-decoration: underline;
  cursor: pointer;
}
.diagnostic-message {
  flex: 1 1 240px;
  font-family: var(--font-mono);
}
.diagnostic-rule {
  color: var(--text-muted);
  font-size: var(--text-xs);
}
</style>
