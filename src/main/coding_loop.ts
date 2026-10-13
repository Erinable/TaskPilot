// Pure rules of the automatic coding loop: how many retries a chain gets,
// what feedback the next round receives, and which files an automatic round
// may apply without the developer.
//
// [人工决策-2026-10-12 15:08:39] 检查失败和 QA 驳回共用 3 轮自动重试；第一轮由人按文件确认，
// 自动轮的补丁没碰高风险路径就直接应用，碰了才停下等人。
import type { CheckRun, Evidence, QaReport } from '../shared/ipc_types.ts';
import { MAX_AUTO_ATTEMPTS } from '../shared/coding_types.ts';
import type { CodingPatchPreview, CodingRound, CodingRun } from '../shared/coding_types.ts';

const MAX_OUTPUT_TAIL = 4000;
const MAX_LISTED_TESTS = 20;

// The developer's round is attempt 1; automatic rounds come after it.
export const canRetry = (run: Pick<CodingRun, 'attempt'>): boolean => run.attempt - 1 < MAX_AUTO_ATTEMPTS;

export const roundOf = (run: CodingRun): CodingRound => ({
  attempt: run.attempt,
  trigger: run.trigger,
  status: run.status,
  costUsd: run.usage.costUsd,
  files: run.files.length,
});

type FailedRun = Pick<CheckRun, 'command' | 'exitCode' | 'timedOut' | 'output'>;
type CheckEvidence = Pick<Evidence, 'kind' | 'status' | 'reason' | 'newFailures'>;

// Blocking submit checks that failed, with their output, for the next round.
export const checksFeedback = (failures: { evidence: CheckEvidence; run: FailedRun | null }[]): string =>
  [
    'The submit checks failed after your previous patch was applied. Fix the cause; do not weaken or delete the tests.',
    ...failures.map(({ evidence, run }) =>
      [
        `## ${evidence.kind}: ${evidence.reason ?? 'failed'}`,
        evidence.newFailures.length ? `New failures: ${evidence.newFailures.slice(0, MAX_LISTED_TESTS).join(', ')}` : null,
        run ? `Command: ${run.command} (exit ${run.exitCode}${run.timedOut ? ', timed out' : ''})` : null,
        run?.output ? `Output (tail):\n${run.output.slice(-MAX_OUTPUT_TAIL)}` : null,
      ]
        .filter(Boolean)
        .join('\n'),
    ),
  ].join('\n\n');

// QA's rejection, issue by issue, for the next round.
export const reviewFeedback = (review: { reasons: string[]; report: QaReport | null; checks: CheckEvidence[] }): string => {
  const failedChecks = review.checks.filter((check) => check.status === 'fail');
  return [
    'QA rejected your previous patch. Address every issue below.',
    `Reasons: ${review.reasons.join(', ') || 'unspecified'}`,
    review.report?.summary ? `Summary: ${review.report.summary}` : null,
    ...(review.report?.issues ?? []).map(
      (issue) => `- [${issue.severity}] ${issue.file ? `${issue.file}${issue.line ? `:${issue.line}` : ''} ` : ''}${issue.text}`,
    ),
    ...(review.report?.criteria ?? [])
      .filter((criterion) => criterion.status !== 'met')
      .map((criterion) => `- Acceptance criterion ${criterion.index + 1} is ${criterion.status}${criterion.note ? `: ${criterion.note}` : ''}`),
    ...failedChecks.map(
      (check) => `- ${check.kind} failed (${check.reason ?? 'failed'})${check.newFailures.length ? `: ${check.newFailures.join(', ')}` : ''}`,
    ),
  ]
    .filter(Boolean)
    .join('\n');
};

// Files an automatic round applies on its own: everything not blocked.
// Any high-risk file stops the round for the developer instead.
export const autoApply = (preview: Pick<CodingPatchPreview, 'files' | 'blocked'>): { files: string[]; highRisk: boolean } => {
  if (preview.files.some((file) => file.highRisk)) return { files: [], highRisk: true };
  const blocked = new Set(preview.blocked.map((entry) => entry.path));
  return { files: preview.files.map((file) => file.path).filter((filePath) => !blocked.has(filePath)), highRisk: false };
};
