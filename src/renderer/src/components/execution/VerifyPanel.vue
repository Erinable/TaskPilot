<script setup lang="ts">
import { computed } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import TermHint from '@/components/TermHint.vue';
import * as reviewModel from '@/lib/review_model.ts';
import { STEP_HINTS, stepIcon, stepLabel } from '@/lib/check_steps.ts';
import { businessDateTime } from '@/lib/time_zone.ts';
import { useExecutionStore } from '@/stores/execution.ts';
import type * as packageTypes from '@shared/ipc/packages.ts';
import type * as workspaceTypes from '@shared/ipc/workspace.ts';
import type { StepKind } from '@shared/check_steps.ts';
import DiagnosticList from './DiagnosticList.vue';
import EvidenceRow from './EvidenceRow.vue';
import FailureExplain from './FailureExplain.vue';

const props = defineProps<{ task: packageTypes.TaskView }>();

const execution = useExecutionStore();

// One button per step that runs here; the tooltip explains it in plain words.
const segments = computed(() =>
  execution.verifySteps.map((step) => ({
    kind: step.id,
    icon: stepIcon(step.id),
    label: stepLabel(step.id, step.label),
    hint: STEP_HINTS[step.id as StepKind] ?? '项目自定义的检查步骤',
  })),
);
const runningLabel = computed(() =>
  execution.verifyKind ? stepLabel(execution.verifyKind, execution.verifySteps.find((step) => step.id === execution.verifyKind)?.label) : '',
);

const baseline = computed(() => reviewModel.baselineText(props.task.baselineChecks));
const result = computed(() => execution.verifyResult);

type HistoryStatus = workspaceTypes.EvidenceStatus | 'missing';
const historyLabels: Record<HistoryStatus, string> = { pass: '通过', fail: '失败', unverifiable: '无法验证', skipped: '未运行', missing: '缺少运行记录' };
const historyStatus = (run: workspaceTypes.CompactRun | workspaceTypes.CheckRun | null, evidence?: workspaceTypes.EvidenceStatus): HistoryStatus => {
  if (evidence === 'skipped') return 'skipped';
  if (!run) return 'missing';
  if ('error' in run) return 'unverifiable';
  if (run.timedOut || run.exitCode !== 0 || !run.summary.ok || run.summary.failed > 0) return 'fail';
  if (run.report && !run.report.trusted) return 'unverifiable';
  return evidence ?? 'pass';
};
const history = computed(() => {
  const review = props.task.review;
  // An active or failed review must not borrow an older coding round's success.
  if (review?.status === 'running' || review?.status === 'failed') {
    return {
      title: review.status === 'running' ? '本次提交检查与审查进行中' : '本次审查未完成，暂无完整检查记录',
      at: review.finishedAt || review.startedAt,
      checks: [],
    };
  }
  if (review) {
    return {
      title: '上次提交检查',
      at: review.finishedAt || review.startedAt,
      checks: review.checks.map((check) => ({ kind: check.kind, status: historyStatus(check.run, check.status) })),
    };
  }
  const codingRun = props.task.codingRun;
  if (!codingRun) return { title: '暂无自动检查历史', at: null, checks: [] };
  if (['preparing', 'running', 'checking', 'applying', 'verifying'].includes(codingRun.status)) {
    return { title: '本轮编码与自动检查尚未完成', at: null, checks: [] };
  }
  return {
    title: '上次编码检查',
    at: codingRun.finishedAt,
    checks: Object.values(codingRun.checks)
      .filter((check): check is workspaceTypes.CheckRun => !!check)
      .map((check) => ({ kind: check.kind, status: historyStatus(check) })),
  };
});
const historyPassed = computed(() => history.value.checks.filter((check) => check.status === 'pass').length);
const historySummary = computed(() => {
  const { title, checks } = history.value;
  if (checks.length) return `${title}：${historyPassed.value}/${checks.length} 项通过`;
  if (props.task.review?.status === 'passed' || props.task.review?.status === 'rejected' || title === '上次编码检查') return `${title}：没有记录自动检查`;
  return title;
});
const historyTime = computed(() => {
  const at = history.value.at;
  if (!at || !Number.isFinite(Date.parse(at))) return '';
  return businessDateTime(new Date(at));
});
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
// Older main processes send no diagnostics; the failing tests stand in.
const diagnostics = computed(
  () =>
    result.value?.diagnostics ??
    failures.value.map((entry) => ({ file: null, line: null, column: null, severity: 'error' as const, message: entry.fullName ?? entry.name, rule: null })),
);
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
          <h2>手动复查</h2>
          <p>在当前主机的项目工作区运行检查，使用你自己的账号权限</p>
        </div>
      </div>
    </div>
    <div class="check-history" data-check-history aria-live="polite">
      <p class="history-summary">{{ historySummary }}</p>
      <time v-if="historyTime" :datetime="history.at ?? undefined">{{ historyTime }}</time>
      <details v-if="history.checks.length" class="history-details">
        <summary>查看 {{ history.checks.length }} 项历史检查</summary>
        <ul class="history-checks">
          <li v-for="(check, index) in history.checks" :key="`${check.kind}-${index}`" :data-check-status="check.status">
            <span>{{ stepLabel(check.kind, execution.verifySteps.find((step) => step.id === check.kind)?.label) }}</span>
            <span :class="{ 'warn-text': check.status !== 'pass' }">{{ historyLabels[check.status] }}</span>
          </li>
        </ul>
      </details>
      <p v-if="history.checks.length" class="history-note">历史结果仅对应当时的提交或编码工作区，不能证明当前工作树仍然通过。</p>
    </div>
    <div v-if="task.codingRun?.status === 'applied'" class="host-warning" role="alert">
      <AppIcon name="alert" />
      Coding Agent 的改动已写进项目。下面的检查用你自己的账号权限运行，会执行项目里的代码。
    </div>
    <div class="segmented" role="group" aria-label="手动复查命令">
      <button
        v-for="segment in segments"
        :key="segment.kind"
        class="segment"
        :class="{ selected: execution.verifyKind === segment.kind, running: execution.verifyRunning && execution.verifyKind === segment.kind }"
        type="button"
        :data-verify="segment.kind"
        :title="segment.hint"
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
        正在运行 {{ runningLabel }}…
      </p>
      <p v-else-if="execution.verifyError !== null" class="empty-hint">
        <AppIcon name="alert" />
        {{ execution.verifyError }}
      </p>
      <template v-else-if="result && execution.verifyKind">
        <p class="manual-result-label">本次手动复查结果</p>
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
          {{ runningLabel }} · {{ result.command }}
        </div>
        <EvidenceRow v-if="result.evidence" :item="result.evidence" />
        <div v-if="reportNote" class="verify-note warn-text">
          <AppIcon name="alert" />
          {{ reportNote }}
        </div>
        <DiagnosticList v-if="diagnostics.length > 0" :items="diagnostics" />
        <FailureExplain
          v-if="showOutput"
          :input="{ kind: result.kind, exitCode: result.exitCode, timedOut: result.timedOut, output: result.output, failed: failures.length }"
        />
      </template>
      <p v-else class="empty-hint">
        <AppIcon name="terminal" />
        本次尚未手动复查
      </p>
    </div>
  </section>
</template>

<style scoped>
.check-history {
  margin: 0 var(--panel-pad) var(--space-4);
  padding-bottom: var(--space-3);
  border-bottom: 1px solid var(--line-soft);
  color: var(--text-secondary);
  font-size: var(--text-sm);
  line-height: 1.65;
}
.history-summary {
  margin: 0;
  color: var(--text);
  font-weight: 600;
}
.check-history time {
  display: block;
  font-variant-numeric: tabular-nums;
}
.history-details {
  margin-top: var(--space-2);
}
.history-details summary {
  cursor: pointer;
}
.history-details summary:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 3px;
}
.history-checks {
  margin: var(--space-2) 0 0;
  padding: 0;
  list-style: none;
}
.history-checks li {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 4px var(--space-3);
}
.history-note {
  margin: var(--space-2) 0 0;
  overflow-wrap: anywhere;
}
.manual-result-label {
  margin: 0 0 var(--space-2);
  color: var(--text-secondary);
  font-size: var(--text-sm);
}
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
