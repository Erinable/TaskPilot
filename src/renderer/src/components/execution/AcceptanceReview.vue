<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import InlineCode from '@/components/InlineCode.vue';
import * as reviewModel from '@/lib/review_model.ts';
import { businessDateTime } from '@/lib/time_zone.ts';
import { useExecutionStore } from '@/stores/execution.ts';
import type * as packageTypes from '@shared/ipc/packages.ts';
import EvidenceRow from './EvidenceRow.vue';

type Outcome = Extract<packageTypes.Review, { status: 'passed' | 'rejected' }>;
const props = defineProps<{ task: packageTypes.TaskView; review: Outcome }>();
const execution = useExecutionStore();
const confirmed = ref<string[]>([]);
const effectiveEvidence = computed(() => execution.acceptanceOverride ?? props.review.acceptance);
const criteria = computed(() =>
  reviewModel.criterionRows(props.task.acceptance, effectiveEvidence.value).map((row, index) => {
    const attention = props.review.attention.filter((item) => 'index' in item && item.index === index);
    return {
      ...row,
      index,
      key: `criterion:${index}`,
      needsHuman: row.status !== 'verified' || row.alreadyPassing || attention.length > 0,
      assessment: props.review.report?.criteria.find((item) => item.index === index),
      attention: attention.filter((item) => item.code !== 'criterion_manual').map((item) => reviewModel.attentionText(item, props.task.acceptance)),
    };
  }),
);
const otherAttention = computed(() =>
  props.review.attention
    .filter((item) => !('index' in item) || item.index < 0 || item.index >= props.task.acceptance.length)
    .map((item, index) => ({
      key: `attention:${index}`,
      text: reviewModel.attentionText(item, props.task.acceptance),
    })),
);
const required = computed(() => [...criteria.value.filter((item) => item.needsHuman).map((item) => item.key), ...otherAttention.value.map((item) => item.key)]);
const remaining = computed(() => required.value.filter((key) => !confirmed.value.includes(key)).length);
const canAccept = computed(
  () => props.task.status === 'accepting' && props.task.humanTransitions.includes('accepted') && remaining.value === 0 && !execution.transitioning,
);
const finishedAt = computed(() => (props.review.finishedAt ? businessDateTime(new Date(props.review.finishedAt)) : ''));
// A confirmation belongs to this exact review. Refreshes of identical data keep
// it; a new review, changed evidence or another package requires fresh judgment.
watch(
  () => JSON.stringify([props.task.id, props.task.baseline, props.task.acceptance, props.review, effectiveEvidence.value]),
  () => {
    confirmed.value = [];
  },
);
const decide = (name: 'accepted' | 'acceptance_rejected') => {
  if (name === 'accepted' && !canAccept.value) return;
  execution.runTransition(name).catch((error) => console.error(error));
};
</script>

<template>
  <section class="acceptance-review" aria-label="验收确认" data-acceptance-review>
    <div class="decision-heading">
      <h3>{{ required.length ? '需要你确认' : '验收证据' }}</h3>
      <span v-if="required.length" class="decision-progress" role="status">已确认 {{ required.length - remaining }} / {{ required.length }} 项</span>
    </div>
    <p v-if="required.length" class="decision-intro">请实际检查后逐项勾选。QA 的代码判断供你参考。</p>
    <div v-for="row in criteria" :key="row.index" class="decision-criterion" :data-criterion="row.index">
      <label v-if="row.needsHuman" class="decision-choice">
        <input v-model="confirmed" type="checkbox" :value="row.key" :disabled="execution.transitioning !== null" :data-confirm-criterion="row.index" />
        <span><InlineCode :text="row.text" /></span>
      </label>
      <div v-else class="decision-verified">
        <AppIcon name="check-circle" />
        <span><InlineCode :text="row.text" /></span>
      </div>
      <div class="decision-evidence">
        <span>{{ row.needsHuman ? (confirmed.includes(row.key) ? '你已确认' : '待你确认') : '关联测试已通过' }}</span>
        <span>自动证据：{{ row.note }}{{ row.test ? ` · ${row.test}` : '' }}</span>
        <span v-if="row.alreadyPassing">关联测试在改动前已通过，不能证明本次实现有效。</span>
        <details v-if="row.assessment">
          <summary>QA 判断{{ reviewModel.CRITERION_LABELS[row.assessment.status] }} · 查看依据</summary>
          <p v-if="row.assessment.note"><InlineCode :text="row.assessment.note" /></p>
        </details>
        <p v-for="note in row.attention" :key="note">{{ note }}</p>
      </div>
    </div>
    <label v-for="item in otherAttention" :key="item.key" class="decision-choice decision-attention">
      <input v-model="confirmed" type="checkbox" :value="item.key" :disabled="execution.transitioning !== null" data-confirm-attention />
      <span>{{ item.text }}</span>
    </label>

    <div v-if="review.checks.length" class="decision-checks">
      <h3>提交检查记录</h3>
      <p class="decision-intro">{{ finishedAt ? `审查完成于 ${finishedAt}。` : '' }}以下记录对应上次提交审查时的项目。</p>
      <div class="decision-check-list"><EvidenceRow v-for="(item, index) in review.checks" :key="index" :item="item" /></div>
      <p class="decision-test-note">{{ reviewModel.reviewTestLine(review.verification) }}</p>
    </div>
    <p v-else class="decision-intro">这次审查没有自动检查记录，请确认实际运行结果。</p>

    <div class="decision-footer">
      <p>{{ remaining ? `还有 ${remaining} 项待确认` : '确认无误后验收，接着保存到 git。' }}</p>
      <div class="decision-actions">
        <button
          v-if="task.humanTransitions.includes('acceptance_rejected')"
          class="secondary-button"
          type="button"
          data-transition="acceptance_rejected"
          :disabled="execution.transitioning !== null"
          @click="decide('acceptance_rejected')"
        >
          打回修改
        </button>
        <button
          v-if="task.humanTransitions.includes('accepted')"
          class="primary-button"
          type="button"
          data-transition="accepted"
          :disabled="!canAccept"
          :aria-busy="execution.transitioning === 'accepted'"
          @click="decide('accepted')"
        >
          <AppIcon :name="execution.transitioning === 'accepted' ? 'spinner' : 'check-circle'" :class="{ spin: execution.transitioning === 'accepted' }" />
          确认并验收
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.acceptance-review {
  display: grid;
  gap: var(--space-3);
}
.decision-heading {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: var(--space-2);
}
h3 {
  margin: 0;
  color: var(--text);
  font-size: var(--text-md);
  font-weight: 650;
}
.decision-progress {
  color: var(--text-secondary);
  font-size: var(--text-sm);
  font-variant-numeric: tabular-nums;
}
.decision-intro,
.decision-test-note {
  margin: 0;
  color: var(--text-secondary);
  font-size: var(--text-sm);
  line-height: 1.65;
}
.decision-criterion {
  padding-block: var(--space-3);
  border-top: 1px solid var(--line-soft);
}
.decision-choice,
.decision-verified {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  color: var(--text);
  font-weight: 600;
  line-height: 1.65;
  overflow-wrap: anywhere;
}
.decision-choice {
  cursor: pointer;
}
.decision-choice input {
  flex: none;
  width: 17px;
  height: 17px;
  margin: 4px 0 0;
  color-scheme: light dark;
  accent-color: var(--accent);
  cursor: pointer;
}
.decision-choice input:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 3px;
}
.decision-verified > .icon {
  flex: none;
  margin-top: 4px;
  color: var(--success);
}
.decision-evidence {
  display: grid;
  gap: var(--space-1);
  margin: var(--space-2) 0 0 29px;
  color: var(--text-secondary);
  font-size: var(--text-sm);
  line-height: 1.65;
  overflow-wrap: anywhere;
}
.decision-evidence > span:first-child {
  color: var(--text);
}
.decision-evidence p {
  margin: var(--space-1) 0 0;
}
.decision-evidence summary {
  width: fit-content;
  cursor: pointer;
  color: var(--text-secondary);
}
.decision-attention {
  padding-top: var(--space-2);
  font-weight: 500;
}
.decision-checks {
  display: grid;
  gap: var(--space-2);
  padding-block: var(--space-3);
  border-top: 1px solid var(--line-soft);
}
.decision-check-list {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr));
  gap: var(--space-1) var(--space-4);
}
.decision-check-list :deep(.evidence-row) {
  flex-wrap: wrap;
}
.decision-footer {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: var(--space-3);
  padding-top: var(--space-3);
  border-top: 1px solid var(--line-soft);
}
.decision-footer p {
  margin: 0;
  color: var(--text-secondary);
  font-size: var(--text-sm);
}
.decision-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
</style>
