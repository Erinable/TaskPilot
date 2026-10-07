<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import AppIcon from './AppIcon.vue';
import { openDialogs } from '@/lib/feedback.ts';
import * as search from '@/lib/search.ts';
import { STATUS_LABELS } from '@/components/requirements/requirement_model.ts';
import { usePaletteStore } from '@/stores/palette.ts';
import { useTasksStore } from '@/stores/tasks.ts';
import { useRequirementsStore } from '@/stores/requirements.ts';
import { NAV_GROUPS, useSettingsStore } from '@/stores/settings.ts';
import { useExecutionStore } from '@/stores/execution.ts';
import type { IconName } from '@/lib/icons.ts';

const palette = usePaletteStore();
const tasks = useTasksStore();
const requirements = useRequirementsStore();
const settings = useSettingsStore();
const execution = useExecutionStore();

const query = ref('');
const highlighted = ref(-1);
const input = ref<HTMLInputElement | null>(null);

const KIND_ICONS: Record<search.SearchKind, IconName> = { task: 'queue', requirement: 'sparkle', setting: 'settings' };
const SETTING_ICONS = new Map(NAV_GROUPS.flatMap((group) => group.items.map((item) => [item.page, item.icon] as const)));
const settingEntries = NAV_GROUPS.flatMap((group) => group.items.map(search.settingEntry));

// Rebuilt only when the sources change, not per keystroke.
const index = computed(() => [
  ...tasks.tasks.map(search.taskEntry),
  ...requirements.items.map((item) => search.requirementEntry(item, STATUS_LABELS[item.status])),
  ...settingEntries,
]);
const groups = computed(() => search.search(index.value, query.value));
const flat = computed(() => groups.value.flatMap((group) => group.entries));
const activeEntry = computed(() => flat.value[highlighted.value] ?? null);

const optionId = (entry: search.SearchEntry) => `palette-option-${entry.key.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
const entryIcon = (entry: search.SearchEntry) =>
  entry.target.kind === 'setting' ? (SETTING_ICONS.get(entry.target.page) ?? KIND_ICONS.setting) : KIND_ICONS[entry.kind];

watch(query, () => {
  highlighted.value = flat.value.length ? 0 : -1;
});

watch(
  () => palette.visible,
  (visible) => {
    // While open, App's page shortcuts (Escape, ⌘S, ⌘,) stay out of the way.
    openDialogs.value += visible ? 1 : -1;
    if (!visible) return;
    query.value = '';
    highlighted.value = flat.value.length ? 0 : -1;
    // Startup loaded the list already; this picks up requirements created since.
    requirements.refreshList().catch((error) => console.error(error));
  },
);

const focusInput = () => input.value?.focus();

const scrollToActive = () => {
  nextTick(() => {
    const entry = activeEntry.value;
    if (entry) document.getElementById(optionId(entry))?.scrollIntoView?.({ block: 'nearest' });
  }).catch((error) => console.error(error));
};

const choose = (entry: search.SearchEntry) => {
  palette.closePalette();
  const target = entry.target;
  const action =
    target.kind === 'task' ? execution.open(target.id) : target.kind === 'requirement' ? requirements.open({ id: target.id }) : settings.open(target.page);
  action.catch((error) => console.error(error));
};

const onInputKeydown = (event: KeyboardEvent) => {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    highlighted.value = search.moveHighlight(highlighted.value, event.key === 'ArrowDown' ? 1 : -1, flat.value.length);
    scrollToActive();
  } else if (event.key === 'Enter' && !event.isComposing) {
    event.preventDefault();
    if (activeEntry.value) choose(activeEntry.value);
  } else if (event.key === 'Escape') {
    // Kept from App's document handler, which would leave the execution view.
    event.preventDefault();
    event.stopPropagation();
    palette.closePalette();
  }
};

// ⌘K / Ctrl+K toggles; Escape closes even if focus left the input.
const onDocumentKeydown = (event: KeyboardEvent) => {
  if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k') {
    // Another dialog (confirm box) is open: leave it alone.
    if (!palette.visible && openDialogs.value > 0) return;
    event.preventDefault();
    palette.togglePalette();
  } else if (event.key === 'Escape' && palette.visible) {
    event.preventDefault();
    palette.closePalette();
  }
};

onMounted(() => document.addEventListener('keydown', onDocumentKeydown));
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onDocumentKeydown);
  if (palette.visible) openDialogs.value -= 1;
});
</script>

<template>
  <el-dialog
    :model-value="palette.visible"
    class="command-palette glass-strong"
    title="搜索"
    :show-close="false"
    :close-on-press-escape="false"
    append-to-body
    align-center
    @update:model-value="
      (value: boolean) => {
        if (!value) palette.closePalette();
      }
    "
    @opened="focusInput"
  >
    <template #header><span class="sr-only">搜索工作包、需求和设置</span></template>
    <label class="palette-search">
      <AppIcon name="search" />
      <input
        ref="input"
        v-model="query"
        class="palette-input"
        type="text"
        role="combobox"
        placeholder="搜索工作包、需求和设置"
        autocomplete="off"
        spellcheck="false"
        aria-label="搜索工作包、需求和设置"
        aria-autocomplete="list"
        aria-controls="paletteResults"
        :aria-expanded="flat.length > 0"
        :aria-activedescendant="activeEntry ? optionId(activeEntry) : undefined"
        @keydown="onInputKeydown"
      />
      <kbd class="palette-kbd">Esc</kbd>
    </label>

    <div id="paletteResults" class="palette-results" role="listbox" aria-label="搜索结果">
      <div v-for="group in groups" :key="group.kind" role="group" :aria-labelledby="`palette-group-${group.kind}`" class="palette-group">
        <div :id="`palette-group-${group.kind}`" class="palette-group-label">{{ group.label }}</div>
        <div
          v-for="entry in group.entries"
          :id="optionId(entry)"
          :key="entry.key"
          class="palette-option"
          role="option"
          :data-key="entry.key"
          :aria-selected="activeEntry?.key === entry.key"
          @mousemove="highlighted = flat.indexOf(entry)"
          @mousedown.prevent
          @click="choose(entry)"
        >
          <AppIcon :name="entryIcon(entry)" class="palette-option-icon" />
          <span class="palette-option-title">{{ entry.title }}</span>
          <span class="palette-option-detail">{{ entry.detail }}</span>
        </div>
      </div>
    </div>
    <p v-if="flat.length === 0" class="empty-hint palette-empty">{{ query.trim() ? '没有匹配的结果' : '输入关键词搜索工作包、需求和设置' }}</p>
  </el-dialog>
</template>

<style>
/* Teleported, so not scoped; selected narrowly by the dialog's own class. */
.el-dialog.command-palette {
  width: min(620px, calc(100% - 32px));
  padding: 0;
  border-radius: 18px;
  overflow: hidden;
}
.el-dialog.command-palette .el-dialog__header {
  padding: 0;
  margin: 0;
}
.el-dialog.command-palette .el-dialog__body {
  padding: 0;
}
.el-dialog.command-palette .sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
.el-dialog.command-palette .palette-search {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--line-soft);
  color: var(--text-muted);
}
.el-dialog.command-palette .palette-input {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--text);
  font-size: var(--text-lg);
}
.el-dialog.command-palette .palette-kbd {
  padding: 2px 6px;
  border-radius: 6px;
  background: var(--fill);
  color: var(--text-tertiary);
  font-size: var(--text-sm);
}
.el-dialog.command-palette .palette-results {
  max-height: min(60vh, 460px);
  overflow-y: auto;
  padding: 6px 8px 10px;
}
.el-dialog.command-palette .palette-group-label {
  padding: 10px 10px 4px;
  color: var(--text-tertiary);
  font-size: var(--text-sm);
}
.el-dialog.command-palette .palette-option {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 10px;
  color: var(--text);
  font-size: var(--text-sm);
  cursor: pointer;
}
.el-dialog.command-palette .palette-option[aria-selected='true'] {
  background: var(--accent-soft);
}
.el-dialog.command-palette .palette-option-icon {
  flex: none;
  color: var(--text-muted);
}
.el-dialog.command-palette .palette-option-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.el-dialog.command-palette .palette-option-detail {
  flex: none;
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-tertiary);
  font-size: var(--text-sm);
}
.el-dialog.command-palette .palette-empty {
  margin: 0;
  padding: 18px;
  font-size: var(--text-sm);
}
</style>
