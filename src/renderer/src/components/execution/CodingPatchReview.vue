<script setup lang="ts">
import { computed } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import TermHint from '@/components/TermHint.vue';
import { diffLineKind } from '@/lib/review_model.ts';
import { splitPatch } from '@/lib/coding_patch.ts';
import type * as codingTypes from '@shared/coding_types.ts';

const props = defineProps<{
  patch: codingTypes.CodingPatchPreview | null;
  patchLoading: boolean;
  selectedFiles: string[];
  resolutions: Partial<Record<string, codingTypes.CodingResolution>>;
  highRisk: boolean;
  highRiskConsent: boolean;
  operation: 'status' | 'start' | 'cancel' | 'retry' | 'apply' | null;
  unresolved: string[];
  applyDisabled: boolean;
  applicable: (file: codingTypes.CodingPatchFile) => boolean;
  mergeOf: (filePath: string) => codingTypes.CodingMergeFile | null;
}>();

const emit = defineEmits<{
  (event: 'toggle-file', filePath: string, accepted: boolean): void;
  (event: 'set-resolution', filePath: string, choice: codingTypes.CodingResolution): void;
  (event: 'update-high-risk-consent', value: boolean): void;
  (event: 'apply'): void;
}>();
const toggle = (filePath: string, event: Event) => emit('toggle-file', filePath, (event.target as HTMLInputElement).checked);
const updateConsent = (event: Event) => emit('update-high-risk-consent', (event.target as HTMLInputElement).checked);

const MERGE_LABELS: Record<codingTypes.CodingMergeFile['state'], string> = {
  clean: '',
  merged: '已和你的改动合并',
  conflict: '和你的改动冲突',
};

const choicesFor = (merge: codingTypes.CodingMergeFile) => [
  ...(merge.markers ? [{ value: 'markers' as const, label: '写入冲突标记，我来改' }] : []),
  { value: 'mine' as const, label: '保留我的，跳过 AI 的改动' },
  { value: 'theirs' as const, label: '用 AI 的版本覆盖' },
];

const fileDiffs = computed(() => {
  const segments = props.patch ? splitPatch(props.patch.patch) : [];
  return (props.patch?.files ?? []).map((file, index) => ({
    file,
    lines: (segments[index] ?? '')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => ({ kind: diffLineKind(line), text: line })),
    applicable: props.applicable(file),
    reasons: (props.patch?.blocked ?? []).filter((entry) => entry.path === file.path).map((entry) => entry.reason),
  }));
});
</script>

<template>
  <div class="coding-result">
    <div class="coding-result-heading">
      <strong>
        逐个文件确认
        <TermHint term="patch" label="补丁" />
      </strong>
      <span v-if="props.patchLoading">正在读取补丁…</span>
      <span v-else-if="props.patch">已勾选 {{ props.selectedFiles.length }} / {{ props.patch.files.length }} 个文件</span>
    </div>
    <ul v-if="fileDiffs.length" class="coding-files">
      <li v-for="entry in fileDiffs" :key="entry.file.path">
        <details>
          <summary>
            <input
              type="checkbox"
              :aria-label="`应用 ${entry.file.path}`"
              :checked="props.selectedFiles.includes(entry.file.path)"
              :disabled="!entry.applicable || props.operation !== null"
              @click.stop
              @change="toggle(entry.file.path, $event)"
            />
            <code>{{ entry.file.path }}</code>
            <span>+{{ entry.file.added }} −{{ entry.file.removed }}</span>
            <strong v-if="entry.file.highRisk" class="risk-label">高风险</strong>
            <span v-if="props.mergeOf(entry.file.path)?.state === 'merged'" class="merge-label">{{ MERGE_LABELS.merged }}</span>
            <strong v-if="props.mergeOf(entry.file.path)?.state === 'conflict'" class="conflict-label">{{ MERGE_LABELS.conflict }}</strong>
            <span v-if="!entry.applicable" class="blocked-label">不能应用：{{ entry.reasons.join('；') }}</span>
          </summary>
          <div
            v-if="props.mergeOf(entry.file.path)?.state === 'conflict' && props.selectedFiles.includes(entry.file.path)"
            class="conflict-choice"
            role="radiogroup"
            :aria-label="`${entry.file.path} 的冲突怎么处理`"
          >
            <label v-for="choice in choicesFor(props.mergeOf(entry.file.path)!)" :key="choice.value">
              <input
                type="radio"
                :name="`resolve-${entry.file.path}`"
                :value="choice.value"
                :checked="props.resolutions[entry.file.path] === choice.value"
                :disabled="props.operation !== null"
                @change="emit('set-resolution', entry.file.path, choice.value)"
              />
              {{ choice.label }}
            </label>
          </div>
          <div class="diff-body coding-diff-body">
            <div v-for="(line, index) in entry.lines" :key="index" class="diff-line" :class="line.kind">{{ line.text }}</div>
          </div>
        </details>
      </li>
    </ul>
    <label v-if="props.highRisk" class="risk-consent">
      <input type="checkbox" :checked="props.highRiskConsent" @change="updateConsent" />
      我已检查勾选的高风险文件的 diff，同意应用
    </label>
    <p v-if="props.unresolved.length" class="coding-hint">还有 {{ props.unresolved.length }} 个冲突的文件没选怎么处理。</p>
    <button class="primary-button" type="button" :disabled="props.applyDisabled" @click="emit('apply')">
      <AppIcon name="check" />
      应用勾选的文件并自动检查
    </button>
  </div>
</template>

<style scoped>
.coding-result {
  display: grid;
  gap: 8px;
}
.coding-hint {
  margin: 4px 0 0;
  color: var(--text-secondary);
  font-size: var(--text-sm);
}
.coding-result-heading {
  display: flex;
  justify-content: space-between;
  gap: 10px;
}
.coding-files {
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: var(--text-sm);
}
.coding-files li {
  margin: 4px 0;
}
.coding-files summary {
  display: flex;
  gap: 8px;
  align-items: center;
  cursor: pointer;
}
.coding-files summary:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.coding-files .coding-diff-body {
  margin-top: 6px;
}
.risk-label {
  color: var(--danger);
}
.conflict-label {
  color: var(--warning);
}
.merge-label {
  color: var(--text-tertiary);
}
.conflict-choice {
  display: grid;
  gap: 4px;
  margin: 6px 0 4px 24px;
  font-size: var(--text-sm);
}
.conflict-choice label {
  display: flex;
  gap: 6px;
  align-items: center;
}
.blocked-label {
  color: var(--danger);
}
.risk-consent {
  display: flex;
  gap: 8px;
  align-items: center;
  color: var(--warning);
  font-size: var(--text-sm);
}
</style>
