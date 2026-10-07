<script setup lang="ts">
import { computed } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import TermHint from '@/components/TermHint.vue';
import { describeErrorInfo } from '@/lib/errors.ts';
import type { IconName } from '@/lib/icons.ts';
import { useExecutionStore } from '@/stores/execution.ts';
import type * as ipc from '@shared/ipc_types.ts';
import ReviewResult from './ReviewResult.vue';

const props = defineProps<{ task: ipc.TaskView; review: ipc.Review }>();

const execution = useExecutionStore();

const view = computed((): { hint: string; tone: string; icon: IconName } => {
  const review = props.review;
  if (review.status === 'running') return { hint: '正在运行测试并审查改动…', tone: '', icon: 'spinner' };
  if (review.status === 'failed') return { hint: `审查没有完成：${describeErrorInfo(review.error)}`, tone: 'danger', icon: 'alert' };
  if (review.status === 'passed') {
    const hint =
      review.humanVerdict === 'acceptance_rejected'
        ? '已通过，但你在验收时打回了。'
        : props.task.status === 'accepting'
          ? '已通过，请确认「需要人工确认」各项后验收。'
          : '已通过，工作包已完成。';
    return { hint, tone: 'success', icon: 'check-circle' };
  }
  return { hint: '未通过，已退回给你修改。修改后可再次提交审查。', tone: 'danger', icon: 'x-circle' };
});
const outcome = computed(() => (props.review.status === 'passed' || props.review.status === 'rejected' ? props.review : null));
// Retry is only possible while the package still waits in review.
const canRetry = computed(() => props.review.status === 'failed' && props.task.status === 'in_review');

const run = (action: 'cancel' | 'retry') => {
  execution.runReviewAction(action).catch((error) => console.error(error));
};
</script>

<template>
  <section class="panel glass review-panel" aria-live="polite">
    <div class="panel-heading">
      <div class="panel-title">
        <span class="panel-icon" :class="view.tone"><AppIcon :name="view.icon" :class="{ spin: review.status === 'running' }" /></span>
        <div>
          <h2><TermHint term="review">QA 审查</TermHint></h2>
          <p>{{ view.hint }}</p>
        </div>
      </div>
      <div class="review-actions">
        <button v-if="review.status === 'running'" class="secondary-button small" type="button" data-review="cancel" @click="run('cancel')">
          <AppIcon name="x" />
          取消
        </button>
        <button v-if="canRetry" class="secondary-button small" type="button" data-review="retry" @click="run('retry')">
          <AppIcon name="refresh" />
          重新审查
        </button>
      </div>
    </div>
    <div class="review-body"><ReviewResult v-if="outcome" :task="task" :review="outcome" /></div>
  </section>
</template>
