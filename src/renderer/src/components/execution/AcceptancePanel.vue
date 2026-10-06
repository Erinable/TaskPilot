<script setup lang="ts">
import { computed } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import { criterionRows } from '@/lib/review_model.ts';
import { useExecutionStore } from '@/stores/execution.ts';
import type * as ipc from '@shared/ipc_types.ts';

const props = defineProps<{ task: ipc.TaskView }>();

const execution = useExecutionStore();

// The last verification run wins; otherwise the review's evidence, if any.
const rows = computed(() => {
  const review = props.task.review;
  const fromReview = review && 'acceptance' in review ? review.acceptance : null;
  return criterionRows(props.task.acceptance, execution.acceptanceOverride ?? fromReview);
});
</script>

<template>
  <section class="panel glass">
    <div class="panel-heading"><div class="panel-title"><span class="panel-icon success"><AppIcon name="check-circle" /></span><div><h2>验收条件</h2><p>关联测试通过后自动勾选</p></div></div></div>
    <div class="acceptance-list">
      <div v-for="(row, index) in rows" :key="index" class="criterion" :class="row.tone">
        <span class="criterion-mark"><AppIcon :name="row.icon" /></span>
        <div>
          <span class="criterion-text">{{ row.text }}</span>
          <template v-if="row.test">
            <span class="criterion-test"><AppIcon name="flask" />{{ row.test }} · {{ row.note }}</span>
            <span v-if="row.alreadyPassing" class="criterion-test warn-text"><AppIcon name="info" />改动前就已通过，不能证明这次改动有效</span>
          </template>
          <span v-else class="criterion-test"><AppIcon name="info" />需人工确认</span>
        </div>
      </div>
    </div>
  </section>
</template>
