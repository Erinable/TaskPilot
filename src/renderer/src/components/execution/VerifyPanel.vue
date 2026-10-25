<script setup lang="ts">
import { computed } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import TermHint from '@/components/TermHint.vue';
import { GLOSSARY } from '@/lib/glossary.ts';
import * as reviewModel from '@/lib/review_model.ts';
import type { IconName } from '@/lib/icons.ts';
import { useExecutionStore, VERIFY_LABELS } from '@/stores/execution.ts';
import type * as packageTypes from '@shared/ipc/packages.ts';
import type * as workspaceTypes from '@shared/ipc/workspace.ts';
import EvidenceRow from './EvidenceRow.vue';
import FailureExplain from './FailureExplain.vue';

// Each check names what it does; the tooltip explains it in plain words.
const SEGMENTS: { kind: workspaceTypes.CheckKind; icon: IconName; label: string }[] = [
  { kind: 'test', icon: 'flask', label: '测试' },
  { kind: 'lint', icon: 'wand', label: '代码检查' },
  { kind: 'build', icon: 'box', label: '构建' },
  { kind: 'smoke', icon: 'rocket', label: '冒烟测试' },
];

const props = defineProps<{ task: packageTypes.TaskView }>();

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
// A failure is explained in plain words with the log folded below; a run with
// nothing parsed shows its log open, as the only evidence there is.
const showOutput = computed(() => !!result.value && (!result.value.summary.ok || result.value.summary.total === 0));

const run = (kind: workspaceTypes.CheckKind) => {
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
    <div v-if="task.codingRun?.status === 'applied'" class="host-warning" role="alert">
      <AppIcon name="alert" />
      Coding Agent 的改动已写进项目。下面的检查用你自己的账号权限运行，会执行项目里的代码。
    </div>
    <div class="segmented" role="group" aria-label="验证命令">
      <button
        v-for="segment in SEGMENTS"
        :key="segment.kind"
        class="segment"
        :class="{ selected: execution.verifyKind === segment.kind, running: execution.verifyRunning && execution.verifyKind === segment.kind }"
        type="button"
        :data-verify="segment.kind"
        :title="GLOSSARY[segment.kind].meaning"
        :disabled="execution.verifyRunning"
        @click="run(segment.kind)"
      >
        <AppIcon :name="segment.icon" />
        {{ segment.label }}
      </button>
    </div>
    <div v-if="task.baseline && baseline.text" class="baseline-status" :class="{ measuring: task.baselineChecks?.status === 'measuring' }">
      <p>
        {{ baseline.text }}
        <TermHint term="baseline" label="" />
      </p>
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
        <FailureExplain
          v-if="showOutput"
          :input="{ kind: result.kind, exitCode: result.exitCode, timedOut: result.timedOut, output: result.output, failed: failures.length }"
        />
      </template>
      <p v-else class="empty-hint">
        <AppIcon name="terminal" />
        尚未运行验证。
      </p>
    </div>
  </section>
</template>

<style scoped>
.host-warning {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  padding: 10px;
  color: var(--warning);
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-md);
  background: var(--fill);
  font-size: var(--text-sm);
}
</style>
