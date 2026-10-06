<script setup lang="ts">
import { computed } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import * as reviewModel from '@/lib/review_model.ts';
import type { IconName } from '@/lib/icons.ts';
import { useExecutionStore, VERIFY_LABELS } from '@/stores/execution.ts';
import type * as ipc from '@shared/ipc_types.ts';
import EvidenceRow from './EvidenceRow.vue';

const SEGMENTS: { kind: ipc.CheckKind; icon: IconName; label: string }[] = [
  { kind: 'test', icon: 'flask', label: '测试' },
  { kind: 'lint', icon: 'wand', label: 'Lint' },
  { kind: 'build', icon: 'box', label: 'Build' },
  { kind: 'smoke', icon: 'rocket', label: '冒烟' },
];

const props = defineProps<{ task: ipc.TaskView }>();

const execution = useExecutionStore();

const baseline = computed(() => reviewModel.baselineText(props.task.baselineChecks));
const result = computed(() => execution.verifyResult);
const counts = computed(() => {
  const run = result.value;
  if (!run) return '';
  if (run.summary.total > 0) return `${run.summary.passed}/${run.summary.total} 通过${run.summary.skipped ? ` · ${run.summary.skipped} 跳过` : ''}`;
  return run.timedOut ? '超时' : `退出码 ${run.exitCode}`;
});
const reportNote = computed(() => {
  const report = result.value?.report;
  if (!report || report.trusted) return '';
  return reviewModel.REASONS[`report_${report.problem}`] ?? String(report.problem);
});
const failures = computed(() => (result.value?.results ?? []).filter((entry) => !entry.passed && !entry.skipped && !entry.todo));
// The raw log is the fallback when nothing could be parsed.
const showOutput = computed(() => !!result.value && (!result.value.summary.ok || result.value.summary.total === 0));

const run = (kind: ipc.CheckKind) => {
  execution.runVerification(kind).catch((error) => console.error(error));
};
const remeasure = () => {
  execution.remeasureBaseline().catch((error) => console.error(error));
};
</script>

<template>
  <section class="panel glass">
    <div class="panel-heading">
      <div class="panel-title">
        <span class="panel-icon"><AppIcon name="terminal" /></span>
        <div>
          <h2>验证</h2>
          <p>运行工作区配置的命令</p>
        </div>
      </div>
    </div>
    <div class="segmented" role="group" aria-label="验证命令">
      <button
        v-for="segment in SEGMENTS"
        :key="segment.kind"
        class="segment"
        :class="{ selected: execution.verifyKind === segment.kind, running: execution.verifyRunning && execution.verifyKind === segment.kind }"
        type="button"
        :data-verify="segment.kind"
        :disabled="execution.verifyRunning"
        @click="run(segment.kind)"
      >
        <AppIcon :name="segment.icon" />
        {{ segment.label }}
      </button>
    </div>
    <div v-if="task.baseline && baseline.text" class="baseline-status" :class="{ measuring: task.baselineChecks?.status === 'measuring' }">
      <p>{{ baseline.text }}</p>
      <button v-if="baseline.canRemeasure && task.status === 'in_progress'" class="secondary-button small" type="button" @click="remeasure">
        <AppIcon name="refresh" />
        重新测量基线
      </button>
    </div>
    <div class="verify-result" aria-live="polite">
      <p v-if="execution.verifyRunning && execution.verifyKind" class="empty-hint">
        <AppIcon name="spinner" class="spin" />
        正在运行 {{ VERIFY_LABELS[execution.verifyKind] }}…
      </p>
      <p v-else-if="execution.verifyError !== null" class="empty-hint">
        <AppIcon name="alert" />
        {{ execution.verifyError }}
      </p>
      <template v-else-if="result && execution.verifyKind">
        <div class="verify-summary" :class="result.summary.ok ? 'pass' : 'fail'">
          <span class="verify-verdict">
            <AppIcon :name="result.summary.ok ? 'check-circle' : 'x-circle'" />
            {{ result.summary.ok ? '通过' : '失败' }}
          </span>
          <span class="verify-counts">{{ counts }}</span>
          <span class="verify-duration">
            <AppIcon name="clock" />
            {{ (result.durationMs / 1000).toFixed(1) }}s
          </span>
        </div>
        <div class="verify-command">
          <AppIcon name="terminal" />
          {{ VERIFY_LABELS[execution.verifyKind] }} · {{ result.command }}
        </div>
        <EvidenceRow v-if="result.evidence" :item="result.evidence" />
        <div v-if="reportNote" class="verify-note warn-text">
          <AppIcon name="alert" />
          {{ reportNote }}
        </div>
        <div v-if="failures.length > 0" class="verify-failures">
          <div v-for="(entry, index) in failures" :key="index">
            <AppIcon name="x" />
            {{ entry.fullName ?? entry.name }}
          </div>
        </div>
        <pre v-if="showOutput" class="verify-output">{{ result.output.trim() || '(无输出)' }}</pre>
      </template>
      <p v-else class="empty-hint">
        <AppIcon name="terminal" />
        尚未运行验证。
      </p>
    </div>
  </section>
</template>
