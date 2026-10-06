<script setup lang="ts">
// A ready draft: version suggestion, editable notes, the pre-release
// checklist and the finish / copy / write actions. Model text is text only.
import { computed, ref } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import InlineCode from '@/components/InlineCode.vue';
import * as model from '@/lib/release_model.ts';
import { useReleaseStore } from '@/stores/release.ts';
import WriteNotesDialog from './WriteNotesDialog.vue';
import type * as ipc from '@shared/ipc_types.ts';

const props = defineProps<{ draft: ipc.ReleaseDraft & { plan: ipc.ReleasePlan } }>();

const store = useReleaseStore();
const writeOpen = ref(false);

const plan = computed(() => props.draft.plan);
const remaining = computed(() => plan.value.checklist.length - props.draft.checked.length);

const NOTES_STATUS_TEXT: Record<string, string> = { dirty: '未保存', saving: '保存中…', saved: '已保存', error: '保存失败' };

const onNotesInput = (value: string) => store.editNotes(value);
const onNotesBlur = () => { store.flushNotes().catch((error) => console.error(error)); };
const onCheck = (index: number, value: string | number | boolean) => { store.setChecked(index, value === true).catch((error) => console.error(error)); };
const onFinish = () => { store.finish().catch((error) => console.error(error)); };
const onCopy = () => { store.copyNotes().catch((error) => console.error(error)); };
</script>

<template>
  <section class="panel glass release-version" aria-label="版本建议">
    <div class="panel-heading">
      <div class="panel-title">
        <span class="panel-icon"><AppIcon name="rocket" /></span>
        <div>
          <h2 class="version-line"><span class="version-from">{{ model.versionFrom(plan) }}</span><AppIcon name="arrow-right" /><span class="version-next">{{ plan.nextVersion }}</span></h2>
          <p class="version-reason"><span class="tag">{{ model.BUMP_LABELS[plan.bump] }}</span><InlineCode :text="plan.reason" /></p>
        </div>
      </div>
      <span v-if="draft.input" class="draft-input">{{ model.draftInputLine(draft.input) }}</span>
    </div>
  </section>

  <section class="panel glass release-notes" aria-label="更新说明">
    <div class="panel-heading">
      <div class="panel-title"><span class="panel-icon"><AppIcon name="file" /></span><h2>更新说明</h2></div>
      <div class="notes-actions">
        <span class="notes-status" :class="store.notesStatus" aria-live="polite">{{ NOTES_STATUS_TEXT[store.notesStatus] ?? '' }}</span>
        <button class="secondary-button copy-notes" type="button" @click="onCopy"><AppIcon name="copy" />复制说明</button>
        <button class="secondary-button write-notes" type="button" @click="writeOpen = true"><AppIcon name="file" />写入文件…</button>
      </div>
    </div>
    <div class="notes-body">
      <el-input
        :model-value="store.notesText" type="textarea" :autosize="{ minRows: 8, maxRows: 24 }" aria-label="更新说明" class="notes-editor"
        @update:model-value="onNotesInput" @blur="onNotesBlur"
      />
    </div>
  </section>

  <section class="panel glass release-checklist" aria-label="发布前检查清单">
    <div class="panel-heading">
      <div class="panel-title"><span class="panel-icon"><AppIcon name="list-checks" /></span><h2>发布前检查清单</h2></div>
      <button class="primary-button finish-release" type="button" :disabled="!store.canFinish || store.finishing" @click="onFinish">
        <AppIcon name="check" />{{ store.finishing ? '记录中…' : '完成发布' }}
      </button>
    </div>
    <p v-if="remaining > 0" class="checklist-hint">还有 {{ remaining }} 项未勾选，全部确认后才能完成发布。</p>
    <ul class="checklist">
      <li v-for="(item, index) in plan.checklist" :key="index" class="checklist-item">
        <el-checkbox :model-value="draft.checked.includes(index)" @change="(value: string | number | boolean) => onCheck(index, value)">
          <InlineCode :text="item.text" />
        </el-checkbox>
        <div v-if="item.evidence.length > 0" class="evidence"><code v-for="evidence in item.evidence" :key="evidence">{{ evidence }}</code></div>
      </li>
    </ul>
  </section>

  <WriteNotesDialog v-model="writeOpen" />
</template>

<style scoped>
.version-line { display: flex; align-items: center; gap: 10px; font-family: var(--font-mono); font-size: 18px; }
.version-line .icon { width: 16px; height: 16px; color: var(--text-tertiary); }
.version-from { color: var(--text-muted); }
.version-next { color: var(--accent-strong); }
.version-reason { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 14px; color: var(--text-secondary); }
.version-reason .tag { font-size: 14px; }
.draft-input { color: var(--text-muted); font-size: 14px; white-space: nowrap; }
.notes-actions { display: flex; align-items: center; gap: 8px; }
.notes-status { color: var(--text-tertiary); font-size: 14px; }
.notes-status.saved { color: var(--success); }
.notes-status.error { color: var(--danger); }
.notes-body { padding: 0 20px 20px; }
.notes-editor :deep(textarea) { font: 14px/1.6 var(--font-mono); }
.primary-button, .secondary-button { font-size: 14px; }
.checklist-hint { margin: 0; padding: 0 20px 8px; color: var(--text-muted); font-size: 14px; }
.checklist { margin: 0; padding: 0 20px 18px; list-style: none; display: grid; gap: 10px; }
.checklist-item :deep(.el-checkbox) { height: auto; white-space: normal; align-items: flex-start; }
.checklist-item :deep(.el-checkbox__label) { font-size: 14px; line-height: 1.5; color: var(--text); }
.evidence { display: flex; flex-wrap: wrap; gap: 6px; margin: 4px 0 0 24px; }
.evidence code { padding: 1px 6px; background: var(--fill); border-radius: 5px; font: 14px var(--font-mono); color: var(--text-muted); }
</style>
