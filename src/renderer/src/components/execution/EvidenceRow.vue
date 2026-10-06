<script setup lang="ts">
import { computed } from 'vue';

import * as reviewModel from '@/lib/review_model.ts';
import type * as ipc from '@shared/ipc_types.ts';

const props = defineProps<{ item: ipc.Evidence }>();

const line = computed(() => reviewModel.evidenceLine(props.item));
const label = computed(() => reviewModel.EVIDENCE_STATUS[props.item.status]?.label ?? props.item.status);
const lists = computed(() => ([['新增失败', props.item.newFailures], ['基线上已失败', props.item.preexisting], ['本次修复', props.item.fixed]] as const)
  .filter(([, names]) => names?.length)
  .map(([title, names]) => ({ title, names })));
</script>

<template>
  <div class="evidence-row">
    <span class="status-pill" :class="line.tone">{{ label }}</span>
    <span class="evidence-text">{{ line.text }}</span>
    <details v-for="list in lists" :key="list.title" class="evidence-list">
      <summary>{{ list.title }}（{{ list.names.length }}）</summary>
      <div v-for="(name, index) in list.names" :key="index">{{ name }}</div>
    </details>
  </div>
</template>
