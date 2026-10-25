<script setup lang="ts">
import { computed } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import InlineCode from '@/components/InlineCode.vue';
import { describeErrorInfo } from '@/lib/errors.ts';
import * as reviewModel from '@/lib/review_model.ts';
import { openWorkspaceFile } from '@/lib/open_file.ts';
import type * as packageTypes from '@shared/ipc/packages.ts';
import EvidenceRow from './EvidenceRow.vue';
import FailureExplain from './FailureExplain.vue';

export type ReviewOutcome = Extract<packageTypes.Review, { status: 'passed' | 'rejected' }>;

const props = defineProps<{ task: packageTypes.TaskView; review: ReviewOutcome }>();

const report = computed(() => props.review.report);
const verification = computed(() => props.review.verification);

const testLine = computed(() => {
  const run = verification.value;
  if (!run) return '未配置测试命令';
  if ('error' in run) return `测试运行失败：${describeErrorInfo(run.error)}`;
  return `测试 ${run.summary.passed}/${run.summary.total} 通过${run.summary.ok ? '' : `（退出码 ${run.exitCode}${run.timedOut ? '，超时' : ''}）`}`;
});
const failing = computed(() => (verification.value && 'failing' in verification.value ? verification.value.failing : []));
// A test run that failed, explained from the output tail the review kept.
const failedRun = computed(() => {
  const run = verification.value;
  if (!run || 'error' in run || run.summary.ok) return null;
  return { kind: run.kind, exitCode: run.exitCode, timedOut: run.timedOut, output: run.outputTail ?? '', failed: run.failing.length };
});
const finishedAt = computed(() => (props.review.finishedAt ? new Date(props.review.finishedAt).toLocaleString('zh-CN') : ''));
const criterionText = (index: number) => props.task.acceptance[index]?.text ?? `条件 ${index + 1}`;
const issueLocation = (issue: packageTypes.QaReport['issues'][number]) => (issue.line ? `${issue.file}:${issue.line}` : issue.file);
</script>

<template>
  <ul v-if="review.reasons.length > 0" class="review-reasons">
    <li v-for="reason in review.reasons" :key="reason">
      <AppIcon name="x" />
      {{ reviewModel.REVIEW_REASONS[reason] ?? reason }}
    </li>
  </ul>
  <template v-if="report">
    <p class="review-summary"><InlineCode :text="report.summary" /></p>
    <div v-if="report.criteria.length" class="review-section">
      <h3>验收条件</h3>
      <div v-for="(criterion, index) in report.criteria" :key="index" class="review-criterion" :class="criterion.status">
        <AppIcon :name="reviewModel.CRITERION_ICONS[criterion.status]" />
        <div>
          <span class="criterion-text">{{ criterionText(criterion.index) }}</span>
          <small>
            {{ reviewModel.CRITERION_LABELS[criterion.status] }}{{ criterion.note ? '：' : '' }}
            <InlineCode v-if="criterion.note" :text="criterion.note" />
          </small>
        </div>
      </div>
    </div>
    <div class="review-section">
      <h3>问题（{{ report.issues.length }}）</h3>
      <div v-for="(issue, index) in report.issues" :key="index" class="review-issue" :class="issue.severity">
        <span class="severity-tag" :class="issue.severity">{{ reviewModel.SEVERITY_LABELS[issue.severity] }}</span>
        <div>
          <p><InlineCode :text="issue.text" /></p>
          <!-- The location is model text; the main process confines it to the workspace. -->
          <button
            v-if="issue.file"
            class="issue-location"
            type="button"
            :title="`在编辑器中打开 ${issueLocation(issue)}`"
            @click="openWorkspaceFile(issue.file, issue.line)"
          >
            <AppIcon name="file" />
            {{ issueLocation(issue) }}
            <AppIcon name="external-link" class="issue-open" />
          </button>
        </div>
      </div>
      <p v-if="report.issues.length === 0" class="empty-hint">
        <AppIcon name="check" />
        QA 没有发现问题。
      </p>
    </div>
  </template>
  <div v-if="review.checks?.length" class="review-section">
    <h3>检查证据</h3>
    <EvidenceRow v-for="(item, index) in review.checks" :key="index" :item="item" />
  </div>
  <div v-if="review.attention?.length" class="review-section">
    <h3>需要人工确认</h3>
    <div v-for="(item, index) in review.attention" :key="index" class="review-attention">
      <AppIcon name="alert" />
      {{ reviewModel.attentionText(item, task.acceptance) }}
    </div>
  </div>
  <div v-if="review.diff.skipped.length > 0" class="review-section">
    <h3>未审查的文件</h3>
    <div v-for="skip in review.diff.skipped" :key="skip.path" class="review-skipped">
      <AppIcon name="file" />
      {{ skip.path }} · {{ reviewModel.SKIP_LABELS[skip.reason] ?? skip.reason }}
    </div>
  </div>
  <div class="review-meta">
    <span>
      <AppIcon name="flask" />
      {{ testLine }}
    </span>
    <span>
      <AppIcon name="diff" />
      审查了 {{ review.diff.files.length }} 个文件
    </span>
    <span v-if="review.costUsd > 0">
      <AppIcon name="activity" />
      费用 ${{ review.costUsd.toFixed(4) }}
    </span>
    <span v-if="finishedAt">
      <AppIcon name="clock" />
      {{ finishedAt }}
    </span>
  </div>
  <div v-if="failing.length" class="verify-failures">
    <div v-for="(name, index) in failing" :key="index">
      <AppIcon name="x" />
      {{ name }}
    </div>
  </div>
  <FailureExplain v-if="failedRun" :input="failedRun" output-label="查看测试输出的最后部分" />
</template>
