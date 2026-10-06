<script setup lang="ts">
// Asks which .md file inside the workspace gets the notes inserted at the top.
import { ref, watch } from 'vue';

import { NOTES_PATH_SUGGESTIONS } from '@/lib/release_model.ts';
import { useReleaseStore } from '@/stores/release.ts';

const visible = defineModel<boolean>({ required: true });

const store = useReleaseStore();
const path = ref(NOTES_PATH_SUGGESTIONS[0]);

watch(visible, (open) => { if (open) store.clearWriteError(); });

const onPathChange = (value: string) => {
  path.value = value;
  store.clearWriteError();
};

const confirm = async () => {
  if (await store.writeNotes(path.value)) visible.value = false;
};
</script>

<template>
  <el-dialog v-model="visible" width="460px" class="glass-strong release-write-dialog" append-to-body>
    <template #header><h2 class="write-title">写入更新说明</h2></template>
    <p class="write-hint">把当前说明插入到工作区内这个 Markdown 文件的开头。文件不存在会新建。不会提交或推送。</p>
    <label class="write-label" for="release-notes-path">文件路径（相对工作区）</label>
    <el-select
      id="release-notes-path" :model-value="path" class="write-path" filterable allow-create default-first-option
      aria-label="文件路径" :aria-invalid="store.writeError ? 'true' : 'false'" aria-describedby="release-notes-path-error"
      @update:model-value="onPathChange"
    >
      <el-option v-for="suggestion in NOTES_PATH_SUGGESTIONS" :key="suggestion" :label="suggestion" :value="suggestion" />
    </el-select>
    <p id="release-notes-path-error" class="write-error" role="alert">{{ store.writeError ?? '' }}</p>
    <template #footer>
      <button class="secondary-button" type="button" @click="visible = false">取消</button>
      <button class="primary-button write-confirm" type="button" :disabled="store.writing" @click="confirm">{{ store.writing ? '写入中…' : '写入' }}</button>
    </template>
  </el-dialog>
</template>

<style scoped>
.write-title { margin: 0; font-size: 16px; font-weight: 650; }
.write-hint { margin: 0 0 14px; color: var(--text-muted); font-size: 14px; line-height: 1.6; }
.write-label { display: block; margin-bottom: 6px; color: var(--text-secondary); font-size: 14px; font-weight: 600; }
.write-path { width: 100%; }
.write-error { min-height: 20px; margin: 6px 0 0; color: var(--danger); font-size: 14px; }
.primary-button, .secondary-button { font-size: 14px; }
.write-confirm { margin-left: 8px; }
</style>
