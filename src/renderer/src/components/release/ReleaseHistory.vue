<script setup lang="ts">
// Finished releases, newest first. Notes and checklists are model or user
// text and render as text only.
import { computed, ref } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import InlineCode from '@/components/InlineCode.vue';
import * as model from '@/lib/release_model.ts';
import type * as ipc from '@shared/ipc_types.ts';

const props = defineProps<{ releases: ipc.Release[] }>();

const limit = ref(model.HISTORY_PAGE);
const expanded = ref<Set<string>>(new Set());

const shown = computed(() => props.releases.slice(0, limit.value));

const toggle = (id: string) => {
  const next = new Set(expanded.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expanded.value = next;
};
</script>

<template>
  <section class="panel glass release-history" aria-label="发布历史">
    <div class="panel-heading">
      <div class="panel-title">
        <span class="panel-icon"><AppIcon name="clock" /></span>
        <h2>发布历史</h2>
      </div>
    </div>
    <p v-if="releases.length === 0" class="empty-hint">
      <AppIcon name="inbox" />
      还没有完成的发布。
    </p>
    <div v-for="release in shown" :key="release.id" class="history-row">
      <button
        class="history-summary"
        type="button"
        :aria-expanded="expanded.has(release.id)"
        :aria-controls="`release-${release.id}`"
        @click="toggle(release.id)"
      >
        <strong class="history-version">{{ release.version }}</strong>
        <time :datetime="release.finishedAt">{{ model.formatTime(release.finishedAt) }}</time>
        <span class="history-count">{{ release.packageIds.length }} 个工作包</span>
        <AppIcon name="chevron-down" class="history-chevron" :class="{ open: expanded.has(release.id) }" />
      </button>
      <div v-if="expanded.has(release.id)" :id="`release-${release.id}`" class="history-detail">
        <pre class="history-notes">{{ release.notesText }}</pre>
        <ul class="history-checklist">
          <li v-for="(item, index) in release.checklist" :key="index" :class="{ unchecked: !item.checked }">
            <AppIcon :name="item.checked ? 'check' : 'circle'" />
            <span><InlineCode :text="item.text" /></span>
          </li>
        </ul>
      </div>
    </div>
    <button v-if="releases.length > limit" class="view-all-button" type="button" @click="limit += model.HISTORY_PAGE">
      显示更多（还有 {{ releases.length - limit }} 个）
      <AppIcon name="arrow-right" />
    </button>
  </section>
</template>

<style scoped>
.history-row {
  border-top: 1px solid var(--line-soft);
}
.history-summary {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px 20px;
  text-align: left;
  font-size: 14px;
  color: var(--text-secondary);
  cursor: pointer;
}
.history-summary:hover {
  background: var(--fill-hover);
}
.history-version {
  color: var(--text);
  font-family: var(--font-mono);
}
.history-count {
  color: var(--text-muted);
}
.history-chevron {
  margin-left: auto;
  width: 15px;
  height: 15px;
  transition: transform 0.15s var(--ease);
}
.history-chevron.open {
  transform: rotate(180deg);
}
.history-detail {
  padding: 0 20px 16px;
}
.history-notes {
  margin: 0 0 10px;
  padding: 12px;
  white-space: pre-wrap;
  word-break: break-word;
  background: var(--fill);
  border-radius: var(--radius-sm);
  font: 14px/1.6 var(--font-mono);
  color: var(--text-secondary);
}
.history-checklist {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 6px;
  font-size: 14px;
}
.history-checklist li {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.history-checklist li .icon {
  width: 14px;
  height: 14px;
  flex: 0 0 14px;
  margin-top: 3px;
  color: var(--success);
}
.history-checklist li.unchecked .icon {
  color: var(--text-tertiary);
}
</style>
