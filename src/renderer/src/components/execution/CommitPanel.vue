<script setup lang="ts">
// Saving a finished package into git history: the files inside its scope,
// a suggested message the developer can edit, and a button. Nothing is
// committed without that click, and nothing is ever pushed.
import { onMounted, watch } from 'vue';
import { storeToRefs } from 'pinia';

import AppIcon from '@/components/AppIcon.vue';
import { useCommitStore } from '@/stores/commit.ts';
import type * as ipc from '@shared/ipc_types.ts';

const props = defineProps<{ task: ipc.TaskView }>();

const SKIP_LABELS: Record<ipc.CommitSkipReason, string> = {
  out_of_scope: '不在这个工作包的文件范围内',
  secret: '可能含有密钥，不会自动提交',
  rename: '改名的文件请自己提交',
};

const store = useCommitStore();
const { preview, message, loading, committing, error, committed, canCommit } = storeToRefs(store);
const load = () => store.load();
const commit = () => store.commit();

onMounted(() => store.open(props.task.id));
// Becoming accepted or done while the page is open makes it committable.
watch(
  () => props.task.status,
  () => store.load().catch((caught) => console.error(caught)),
);
</script>

<template>
  <section class="panel glass commit-panel" aria-labelledby="commitTitle" data-panel="commit">
    <div class="panel-heading">
      <div class="panel-title">
        <span class="panel-icon"><AppIcon name="commit" /></span>
        <div>
          <h2 id="commitTitle">保存到 git</h2>
          <p>把这个工作包改的文件存成一次提交（commit），下一个工作包才能从干净的状态开始。只在本机，不会推送。</p>
        </div>
      </div>
    </div>

    <p v-if="committed" class="commit-done" role="status">
      <AppIcon name="check-circle" />
      已提交 {{ committed.files.length }} 个文件，提交号
      <code>{{ committed.commit.slice(0, 8) }}</code>
      。要分享给别人时，再用 git push 推送到远程。
    </p>
    <p v-else-if="loading && !preview" class="empty-hint">
      <AppIcon name="spinner" class="spin" />
      正在查看改动…
    </p>
    <p v-else-if="error" class="empty-hint">
      <AppIcon name="alert" />
      {{ error }}
      <button class="empty-action" type="button" @click="load">重试</button>
    </p>
    <template v-else-if="preview">
      <p v-if="preview.files.length === 0" class="empty-hint" data-empty="commit">
        <AppIcon name="check-circle" />
        文件范围内没有未提交的改动，可能已经提交过了。
        <button class="empty-action" type="button" @click="load">重新检查</button>
      </p>
      <div v-else class="commit-body">
        <ul class="commit-files" aria-label="将要提交的文件">
          <li v-for="file in preview.files" :key="file">
            <AppIcon name="file" />
            <code>{{ file }}</code>
          </li>
        </ul>
        <label class="commit-label" for="commitMessage">提交说明（写给以后的自己看，说清楚这次改了什么）</label>
        <el-input id="commitMessage" v-model="message" type="textarea" :rows="3" :maxlength="2000" />
        <div class="commit-actions">
          <button class="primary-button" type="button" :disabled="!canCommit" :aria-busy="committing" @click="commit">
            <AppIcon :name="committing ? 'spinner' : 'commit'" :class="{ spin: committing }" />
            {{ committing ? '提交中…' : `提交 ${preview.files.length} 个文件` }}
          </button>
        </div>
      </div>
      <div v-if="preview.skipped.length" class="commit-skipped">
        <p>这些文件也有改动，但不会包含在这次提交里：</p>
        <ul>
          <li v-for="item in preview.skipped" :key="item.path">
            <code>{{ item.path }}</code>
            <span>{{ SKIP_LABELS[item.reason] }}</span>
          </li>
        </ul>
      </div>
    </template>
  </section>
</template>
