<script setup lang="ts">
import { computed } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import TermHint from '@/components/TermHint.vue';
import InlineCode from '@/components/InlineCode.vue';
import { describeErrorInfo } from '@/lib/errors.ts';
import { resolutionTitle } from '@/lib/review_model.ts';
import type { IconName } from '@/lib/icons.ts';
import { useExecutionStore } from '@/stores/execution.ts';
import type * as ipc from '@shared/ipc_types.ts';

const props = defineProps<{ task: ipc.TaskView }>();

const execution = useExecutionStore();

const view = computed((): { hint: string; icon: IconName; action: { name: 'cancel' | 'retry'; icon: IconName; label: string } | null } => {
  const { adjudication, deviations, status } = props.task;
  if (adjudication?.status === 'running') {
    return {
      hint: adjudication.mustReplan ? 'Architect 正在按你的异议重新规划…' : 'Architect 正在读代码并裁决…',
      icon: 'spinner',
      action: { name: 'cancel', icon: 'x', label: '取消' },
    };
  }
  if (adjudication?.status === 'failed' && status === 'deviation') {
    return { hint: `裁决没有完成：${describeErrorInfo(adjudication.error)}`, icon: 'alert', action: { name: 'retry', icon: 'refresh', label: '重新裁决' } };
  }
  return { hint: deviations.length ? `共 ${deviations.length} 条，裁决结果已自动生效，可在上方撤销。` : '', icon: 'flag', action: null };
});
const revisionTitle = computed(() =>
  props.task.revision
    ? `当前是第 ${props.task.revision.version} 版计划，${new Date(props.task.revision.revisedAt).toLocaleString('zh-CN')} 由 Architect 修订`
    : '',
);
const when = (iso: string) => new Date(iso).toLocaleString('zh-CN');

const run = (action: 'cancel' | 'retry') => {
  execution.runDeviationAction(action).catch((error) => console.error(error));
};
</script>

<template>
  <section v-if="task.deviations.length > 0 || task.revision" class="panel glass" aria-live="polite">
    <div class="panel-heading">
      <div class="panel-title">
        <span class="panel-icon danger"><AppIcon :name="view.icon" :class="{ spin: view.icon === 'spinner' }" /></span>
        <div>
          <h2><TermHint term="deviation">偏差与裁决</TermHint></h2>
          <p>{{ view.hint }}</p>
        </div>
      </div>
      <div class="review-actions">
        <button v-if="view.action" class="secondary-button small" type="button" :data-deviation="view.action.name" @click="run(view.action.name)">
          <AppIcon :name="view.action.icon" />
          {{ view.action.label }}
        </button>
      </div>
    </div>
    <div v-if="task.revision" class="deviation-revision">
      <div class="deviation-revision-title">
        <AppIcon name="wand" />
        {{ revisionTitle }}
      </div>
    </div>
    <div class="deviation-list">
      <div v-for="(deviation, index) in task.deviations" :key="index" class="deviation-item">
        <p><InlineCode :text="deviation.note" /></p>
        <small>
          <span>
            <AppIcon name="clock" />
            {{ when(deviation.reportedAt) }}
          </span>
          <span v-if="deviation.stepIndex !== null">
            <AppIcon name="list-checks" />
            指令 {{ deviation.stepIndex + 1 }}
          </span>
          <span v-if="deviation.filePath">
            <AppIcon name="file" />
            {{ deviation.filePath }}
          </span>
        </small>
        <div v-if="deviation.resolution" class="deviation-resolution" :class="deviation.resolution.decision">
          <strong>
            <AppIcon name="bot" />
            {{ resolutionTitle(deviation.resolution) }}
          </strong>
          <p><InlineCode :text="deviation.resolution.reason" /></p>
          <ul v-if="deviation.resolution.changes?.length">
            <li v-for="(change, changeIndex) in deviation.resolution.changes" :key="changeIndex"><InlineCode :text="change" /></li>
          </ul>
        </div>
      </div>
    </div>
  </section>
</template>
