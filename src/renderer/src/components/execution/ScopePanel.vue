<script setup lang="ts">
import { computed, ref } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import TermHint from '@/components/TermHint.vue';
import { openWorkspaceFile } from '@/lib/open_file.ts';
import { useExecutionStore } from '@/stores/execution.ts';
import type * as ipc from '@shared/ipc_types.ts';

type ScopeKind = 'touched' | 'untouched' | 'out';

const LABELS: Record<ScopeKind, string> = { touched: '已改动', untouched: '未改动', out: '超出范围' };

const props = defineProps<{ task: ipc.TaskView }>();

const execution = useExecutionStore();

const rows = computed(() => {
  const churnByPath = new Map((execution.diff?.changes ?? []).map((change) => [change.path, change]));
  const scope = execution.diff?.scope;
  const row = (filePath: string, kind: ScopeKind, churn?: ipc.FileChange) => ({ filePath, kind, churn: churn ?? null });
  // Not claimed yet: show the declared scope without churn.
  if (!scope) return props.task.fileScope.map((filePath) => row(filePath, 'untouched'));
  return [
    ...scope.inScope.map((filePath) => row(filePath, 'touched', churnByPath.get(filePath))),
    ...scope.untouched.map((filePath) => row(filePath, 'untouched')),
    ...scope.outOfScope.map((filePath) => row(filePath, 'out', churnByPath.get(filePath))),
  ];
});

const refreshing = ref(false);
const refresh = () => {
  refreshing.value = true;
  execution
    .refreshDiff()
    .catch((error) => console.error(error))
    .finally(() => (refreshing.value = false));
};
</script>

<template>
  <section class="panel glass">
    <div class="panel-heading">
      <div class="panel-title">
        <span class="panel-icon"><AppIcon name="folder" /></span>
        <div>
          <h2><TermHint term="scope" /></h2>
          <p>工作包允许改动的文件</p>
        </div>
      </div>
      <button class="icon-button small" type="button" title="刷新" aria-label="刷新改动" :disabled="refreshing" @click="refresh">
        <AppIcon :name="refreshing ? 'spinner' : 'refresh'" :class="{ spin: refreshing }" />
      </button>
    </div>
    <div class="scope-list">
      <div v-for="row in rows" :key="`${row.kind}:${row.filePath}`" class="scope-row" :class="row.kind">
        <AppIcon :name="row.kind === 'out' ? 'alert' : 'file'" class="scope-file" />
        <span class="scope-path">{{ row.filePath }}</span>
        <span v-if="row.churn?.untracked" class="scope-tag new">新文件</span>
        <span v-if="row.churn && !row.churn.binary" class="scope-churn">
          <span class="added">+{{ row.churn.added }}</span>
          <span class="removed">-{{ row.churn.removed }}</span>
        </span>
        <span class="scope-tag" :class="row.kind">{{ LABELS[row.kind] }}</span>
        <button
          class="icon-button small scope-open"
          type="button"
          :title="`在编辑器中打开 ${row.filePath}`"
          :aria-label="`在编辑器中打开 ${row.filePath}`"
          @click="openWorkspaceFile(row.filePath)"
        >
          <AppIcon name="external-link" />
        </button>
      </div>
    </div>
  </section>
</template>
