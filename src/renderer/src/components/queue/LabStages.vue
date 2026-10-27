<script setup lang="ts">
// The stage bar of a lab repository, above the queue: each lab in stage
// order (locked / in progress / passed / waiting for review), and the next
// lab while it is generated, with its progress, spend and a cancel button.
// A lab opens the existing execution page. Only titles and counts are
// shown, never a lab's code, tests or hints.
import { computed, ref } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import { formatCost } from '@/lib/activity.ts';
import { elapsedSince, useNow } from '@/lib/elapsed.ts';
import { describeErrorInfo } from '@/lib/errors.ts';
import { STAGE_LABELS, canGenerateNext, labStages, pendingStage } from '@/lib/lab_stages.ts';
import { LAB_PHASE_LABELS } from '@/components/requirements/requirement_model.ts';
import { useExecutionStore } from '@/stores/execution.ts';
import { useRepositoriesStore } from '@/stores/repositories.ts';
import { useRequirementsStore } from '@/stores/requirements.ts';
import type * as packageTypes from '@shared/ipc/packages.ts';
import type * as requirementTypes from '@shared/ipc/requirements.ts';

const props = defineProps<{ tasks: packageTypes.TaskView[]; course: requirementTypes.Requirement | null }>();

const execution = useExecutionStore();
const requirements = useRequirementsStore();
const repositories = useRepositoriesStore();

const report = (promise: Promise<unknown>) => {
  promise.catch((error) => console.error(error));
};

const stages = computed(() => labStages(props.tasks));
const lab = computed(() => props.course?.course?.lab ?? null);
const pending = computed(() => pendingStage(props.course?.course, stages.value));
const segments = computed(() => (pending.value ? [...stages.value, pending.value] : stages.value));
const passed = computed(() => stages.value.filter((stage) => stage.state === 'passed').length);
const canNext = computed(() => canGenerateNext(props.course?.course, stages.value));

const now = useNow();
const elapsed = computed(() => (lab.value?.status === 'running' ? elapsedSince(lab.value.startedAt, now.value) : null));
const cancelling = ref(false);
const cancel = () => {
  if (!props.course) return;
  cancelling.value = true;
  report(requirements.cancelRun(props.course).finally(() => (cancelling.value = false)));
};
const place = () => {
  if (props.course) report(repositories.placeLab(props.course));
};
const next = () => {
  if (props.course) report(requirements.nextLab(props.course));
};
</script>

<template>
  <section v-if="segments.length" class="lab-stages panel glass" data-lab-stages aria-label="lab 阶段">
    <div class="panel-heading">
      <div>
        <h2>实验仓库</h2>
        <p>{{ `${passed} / ${stages.length} 个 lab 已通过` }}</p>
      </div>
      <button v-if="canNext" class="secondary-button small" type="button" data-action="next-lab" @click="next">
        <AppIcon name="flask" />
        生成下一个 lab
      </button>
    </div>
    <ol class="lab-stage-list">
      <li v-for="segment in segments" :key="segment.stage" class="lab-stage" :class="segment.state" :data-stage="segment.stage" :data-state="segment.state">
        <button v-if="segment.taskId" type="button" class="lab-stage-button" @click="execution.open(segment.taskId)">
          <span class="lab-stage-number">{{ segment.stage }}</span>
          <span class="lab-stage-title">{{ segment.title }}</span>
          <span class="lab-stage-state">
            <AppIcon v-if="segment.state === 'locked'" name="ban" />
            <AppIcon v-else-if="segment.state === 'passed'" name="check" />
            {{ STAGE_LABELS[segment.state] }}
          </span>
        </button>
        <div v-else class="lab-stage-button">
          <span class="lab-stage-number">{{ segment.stage }}</span>
          <span class="lab-stage-title">{{ segment.title }}</span>
          <span class="lab-stage-state">{{ lab?.status === 'ready' ? '待写入' : STAGE_LABELS[segment.state] }}</span>
        </div>
      </li>
    </ol>
    <div v-if="lab?.status === 'running'" class="lab-stage-run" data-field="lab-run" aria-live="polite">
      <AppIcon name="spinner" class="spin" />
      <span>{{ lab.phase ? LAB_PHASE_LABELS[lab.phase] : '正在生成 lab…' }}</span>
      <small>已用 {{ elapsed ?? '0 秒' }}，花费 {{ formatCost(lab.costUsd) }}</small>
      <button class="secondary-button small" type="button" data-action="cancel-lab" :disabled="cancelling" @click="cancel">
        <AppIcon name="x" />
        取消
      </button>
    </div>
    <div v-else-if="lab?.status === 'ready' && !lab.placed" class="lab-stage-run" data-field="lab-ready">
      <span>{{ `「${lab.lab?.title ?? ''}」自验证通过，花费 ${formatCost(lab.costUsd)}。` }}</span>
      <button class="primary-button small" type="button" data-action="place-lab" :disabled="requirements.courseBusy" @click="place">
        <AppIcon name="plus" />
        加入实验仓库
      </button>
    </div>
    <p v-else-if="lab?.status === 'failed' || lab?.status === 'needs_review'" class="lab-stage-run" role="alert" data-field="lab-failed">
      <AppIcon name="alert" />
      {{
        lab.status === 'needs_review'
          ? '下一个 lab 自验证没通过，到需求中心选择怎么办。'
          : lab.error?.code === 'agent_cancelled'
            ? '已取消生成下一个 lab。'
            : `生成下一个 lab 失败：${describeErrorInfo(lab.error)}`
      }}
    </p>
  </section>
</template>

<style scoped>
.lab-stages {
  margin-bottom: var(--space-4);
}
.lab-stage-list {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: var(--space-2);
  margin: 0;
  padding: 0 var(--panel-pad) var(--space-3);
  list-style: none;
}
.lab-stage-button {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 2px var(--space-2);
  width: 100%;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  background: var(--fill);
  color: var(--text);
  font: inherit;
  font-size: var(--text-lg);
  text-align: left;
}
button.lab-stage-button {
  cursor: pointer;
}
button.lab-stage-button:hover {
  background: var(--fill-hover);
}
.lab-stage-number {
  grid-row: span 2;
  align-self: center;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}
.lab-stage-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lab-stage-state {
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--text-secondary);
}
.lab-stage.passed .lab-stage-button {
  border-color: var(--success);
  background: var(--success-soft);
}
.lab-stage.active .lab-stage-button {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.lab-stage.review .lab-stage-button {
  border-color: var(--warning);
  background: var(--warning-soft);
}
.lab-stage.locked .lab-stage-button {
  color: var(--text-tertiary);
}
.lab-stage.generating .lab-stage-button {
  border-style: dashed;
}
.lab-stage-run {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  margin: 0;
  padding: 0 var(--panel-pad) var(--panel-pad);
  font-size: var(--text-lg);
}
.lab-stage-run small {
  color: var(--text-secondary);
  font-size: var(--text-lg);
}
</style>
