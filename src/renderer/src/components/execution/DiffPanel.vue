<script setup lang="ts">
import { computed } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import { useExecutionStore } from '@/stores/execution.ts';
import type * as ipc from '@shared/ipc_types.ts';
import DiffFile from './DiffFile.vue';

defineProps<{ task: ipc.TaskView }>();

const execution = useExecutionStore();

const changes = computed(() => execution.diff?.changes ?? []);
</script>

<template>
  <section class="panel glass">
    <div class="panel-heading"><div class="panel-title"><span class="panel-icon"><AppIcon name="diff" /></span><div><h2>改动</h2><p>{{ execution.diffHint }}</p></div></div></div>
    <div class="diff-view">
      <p v-if="!task.baseline" class="empty-hint"><AppIcon name="play" />领取工作包后可查看改动。</p>
      <p v-else-if="changes.length === 0" class="empty-hint"><AppIcon name="check-circle" />相对基线还没有改动。</p>
      <!-- Keyed by refresh so every reload starts collapsed and re-fetches patches. -->
      <DiffFile v-for="change in changes" v-else :key="`${execution.diffVersion}:${change.path}`" :task-id="task.id" :change="change" />
    </div>
  </section>
</template>
