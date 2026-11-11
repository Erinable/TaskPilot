<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import InlineCode from '@/components/InlineCode.vue';
import { businessClock } from '@/lib/time_zone.ts';
import { commandLabel, commandsSummary, fileLabel, transcriptBlocks } from '@/lib/coding_transcript.ts';
import type * as codingTypes from '@shared/coding_types.ts';

const props = defineProps<{ events: codingTypes.CodingEvent[]; live?: boolean }>();

const blocks = computed(() => transcriptBlocks(props.events));
const CHANGE_LABELS = { add: '新增', delete: '删除', update: '修改' } as const;

// A screen reader announces only the newest step, not the whole log each time.
const latest = computed(() => props.events.at(-1)?.text ?? '');

// Follow the newest step while the reader is at the bottom; leave them be once they scroll up.
const scroller = ref<HTMLElement | null>(null);
const pinned = ref(true);
const onScroll = () => {
  const node = scroller.value;
  if (node) pinned.value = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
};
watch(
  () => props.events.length,
  async () => {
    if (!pinned.value) return;
    await nextTick();
    scroller.value?.scrollTo({ top: scroller.value.scrollHeight });
  },
  { immediate: true },
);
</script>

<template>
  <div ref="scroller" class="coding-transcript" role="region" aria-label="编码 Agent 实时记录" @scroll="onScroll">
    <p v-if="blocks.length === 0" class="transcript-empty">
      <AppIcon name="spinner" class="spin" />
      等待 Coding Agent 输出…
    </p>
    <template v-for="block in blocks" :key="block.key">
      <p v-if="block.kind === 'message'" class="t-message"><InlineCode :text="block.text" /></p>

      <details v-else-if="block.kind === 'thinking'" class="t-thinking">
        <summary>思考</summary>
        <p>{{ block.text }}</p>
      </details>

      <p v-else-if="block.kind === 'notice'" class="t-notice">
        <AppIcon name="info" />
        <span>{{ block.text }}</span>
      </p>

      <p v-else-if="block.kind === 'error'" class="t-error" role="alert">
        <AppIcon name="alert" />
        <span>{{ block.text }}</span>
      </p>

      <div v-else-if="block.kind === 'files'" class="t-files" :class="block.item.status">
        <span class="t-files-head">
          <AppIcon :name="block.item.status === 'running' ? 'spinner' : 'file'" :class="{ spin: block.item.status === 'running' }" />
          {{ block.item.status === 'running' ? '正在编辑' : '编辑了' }} {{ block.item.files.length }} 个文件
        </span>
        <ul>
          <li v-for="file in block.item.files" :key="file.path">
            <span class="t-change" :class="file.change">{{ CHANGE_LABELS[file.change] }}</span>
            <code>{{ fileLabel(file.path) }}</code>
          </li>
        </ul>
      </div>

      <details v-else-if="block.kind === 'commands'" class="t-commands" :open="block.commands.some((command) => command.status === 'running') || undefined">
        <summary>
          <AppIcon name="chevron-right" class="t-chevron" />
          <AppIcon name="terminal" />
          <span>{{ commandsSummary(block.commands) }}</span>
          <time>{{ businessClock(new Date(block.at)) }}</time>
        </summary>
        <ol>
          <li v-for="command in block.commands" :key="command.id" class="t-command" :class="command.status">
            <details :open="command.status === 'failed' || undefined">
              <summary>
                <span class="t-prompt" aria-hidden="true">$</span>
                <code class="t-cmd">{{ commandLabel(command.command) }}</code>
                <span v-if="command.status === 'running'" class="t-badge running">
                  <AppIcon name="spinner" class="spin" />
                  运行中
                </span>
                <span v-else-if="command.status === 'failed'" class="t-badge failed">退出码 {{ command.exitCode ?? '?' }}</span>
                <AppIcon v-else name="check" class="t-ok" aria-label="成功" />
              </summary>
              <pre
                v-if="command.output"
                class="t-output"
              ><span v-if="command.outputTruncated" class="t-cut">…前面的输出已省略&#10;</span>{{ command.output }}</pre>
              <p v-else class="t-no-output">{{ command.status === 'running' ? '还没有输出' : '没有输出' }}</p>
            </details>
          </li>
        </ol>
      </details>

      <p v-else class="t-notice">
        <AppIcon name="terminal" />
        <span>{{ block.text }}</span>
      </p>
    </template>
    <p v-if="live && blocks.length" class="t-live">
      <AppIcon name="spinner" class="spin" />
      进行中
    </p>
    <p class="visually-hidden" aria-live="polite">{{ latest }}</p>
  </div>
</template>

<style scoped>
.coding-transcript {
  display: grid;
  align-content: start;
  gap: var(--space-3);
  max-height: 460px;
  overflow: auto;
  padding: var(--space-4);
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-md);
  background: var(--fill);
  font-size: var(--text-sm);
  line-height: 1.6;
  overscroll-behavior: contain;
}
.coding-transcript p {
  margin: 0;
}
.transcript-empty,
.t-live {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--text-tertiary);
  font-size: var(--text-xs);
}
.t-message {
  color: var(--text);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-width: 72ch;
}
.t-message :deep(code),
.t-files code {
  padding: 0 4px;
  border-radius: var(--radius-sm);
  background: var(--fill-hover);
  font: 0.92em var(--font-mono);
}
.t-thinking summary,
.t-notice {
  color: var(--text-tertiary);
  font-size: var(--text-xs);
}
.t-thinking summary {
  cursor: pointer;
}
.t-thinking p {
  margin-top: var(--space-1);
  color: var(--text-secondary);
  font-style: italic;
  white-space: pre-wrap;
}
.t-notice,
.t-error {
  display: flex;
  gap: var(--space-2);
  align-items: flex-start;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.t-notice > .icon,
.t-error > .icon {
  flex: none;
  margin-top: 3px;
}
.t-error {
  color: var(--danger);
}

/* Commands: one quiet row per group, each command a row inside. */
.t-commands {
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-md);
  background: var(--glass-bg-strong);
}
.t-commands > summary {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  color: var(--text-secondary);
  cursor: pointer;
  list-style: none;
}
.t-commands > summary::-webkit-details-marker,
.t-command summary::-webkit-details-marker {
  display: none;
}
.t-commands > summary time {
  margin-left: auto;
  color: var(--text-tertiary);
  font-size: var(--text-xs);
  font-variant-numeric: tabular-nums;
}
.t-chevron {
  transition: transform 160ms cubic-bezier(0.16, 1, 0.3, 1);
}
.t-commands[open] > summary .t-chevron {
  transform: rotate(90deg);
}
.t-commands ol {
  margin: 0;
  padding: 0 0 var(--space-1);
  list-style: none;
  border-top: 1px solid var(--line-soft);
}
.t-command summary {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  padding: 5px var(--space-3);
  cursor: pointer;
  list-style: none;
}
.t-command summary:hover {
  background: var(--fill-hover);
}
.t-prompt {
  flex: none;
  color: var(--text-tertiary);
  font-family: var(--font-mono);
}
.t-cmd {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--text);
  font: var(--text-xs) var(--font-mono);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.t-command details[open] .t-cmd {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.t-ok {
  flex: none;
  color: var(--success);
}
.t-badge {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 4px;
  padding: 0 6px;
  border-radius: var(--radius-sm);
  font-size: var(--text-xs);
  font-variant-numeric: tabular-nums;
}
.t-badge.running {
  color: var(--accent-strong);
  background: var(--accent-soft);
}
.t-badge.failed {
  color: var(--danger);
  background: var(--danger-soft);
}
.t-output,
.t-no-output {
  margin: 0 var(--space-3) var(--space-2) calc(var(--space-3) + 1.2em);
}
.t-output {
  max-height: 240px;
  overflow: auto;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--fill-hover);
  color: var(--text-secondary);
  font: var(--text-xs) / 1.55 var(--font-mono);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.t-cut,
.t-no-output {
  color: var(--text-tertiary);
  font-size: var(--text-xs);
}

/* File edits */
.t-files {
  display: grid;
  gap: var(--space-1);
}
.t-files-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--text-secondary);
}
.t-files ul {
  display: grid;
  gap: 2px;
  margin: 0;
  padding: 0 0 0 calc(16px + var(--space-2));
  list-style: none;
}
.t-files li {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  min-width: 0;
}
.t-files code {
  overflow-wrap: anywhere;
}
.t-change {
  flex: none;
  font-size: var(--text-xs);
  font-weight: 600;
}
.t-change.add {
  color: var(--success);
}
.t-change.delete {
  color: var(--danger);
}
.t-change.update {
  color: var(--warning);
}
@media (prefers-reduced-motion: reduce) {
  .t-chevron {
    transition: none;
  }
}
</style>
