// Pure wording for evidence, baselines, reviews and diffs on the execution
// page. Kept free of Vue and the DOM so it can be tested directly.
import type * as packageTypes from '@shared/ipc/packages.ts';
import type * as workspaceTypes from '@shared/ipc/workspace.ts';
import type { IconName } from './icons.ts';
import { stepLabel } from './check_steps.ts';

export type EvidenceTone = 'done' | 'blocked' | 'in_review' | '';

export const EVIDENCE_STATUS: Record<workspaceTypes.EvidenceStatus, { label: string; tone: EvidenceTone; icon: IconName }> = {
  pass: { label: '通过', tone: 'done', icon: 'check-circle' },
  fail: { label: '失败', tone: 'blocked', icon: 'x-circle' },
  unverifiable: { label: '无法验证', tone: 'in_review', icon: 'alert' },
  skipped: { label: '未运行', tone: '', icon: 'circle' },
};

export const REASONS: Record<string, string> = {
  new_failures: '有相对基线新增的失败',
  no_baseline: '没有基线可对比，失败按本次改动引入处理',
  preexisting_only: '只有基线上就失败的测试仍然失败',
  crashed: '命令异常退出，没有解析到测试结果',
  broken_at_baseline: '基线上同样异常，无法判断这次改动的影响',
  timed_out: '运行超时',
  timed_out_at_baseline: '基线上同样超时',
  report_missing: '没有生成 JUnit 报告',
  report_stale: 'JUnit 报告不是本次运行写入的',
  report_not_a_file: 'JUnit 报告不是普通文件（可能是符号链接）',
  report_outside: 'JUnit 报告指向工作区之外',
  report_too_large: 'JUnit 报告超过 5 MB',
  report_invalid: 'JUnit 报告无法解析',
  command_missing: '找不到可执行文件',
};

const UNAVAILABLE: Record<string, string> = {
  dirty_tree: '领取时工作树有未提交的修改，没有测量基线。提交或还原后可以重新测量。',
  head_moved: '领取后 HEAD 已移动，没有测量基线。',
  no_checks: '没有配置提交前运行的检查，不需要基线。',
  interrupted: '基线测量被中断（应用退出）。',
  cancelled: '基线测量已取消。',
};

const failingCount = (baseline: workspaceTypes.BaselineChecks) =>
  Object.values(baseline.checks ?? {}).reduce((sum, check) => sum + (check && 'failing' in check ? check.failing.length : 0), 0);

const BASELINE: Record<workspaceTypes.BaselineStatus, (baseline: workspaceTypes.BaselineChecks) => string> = {
  measuring: () => '正在基线上运行提交前检查…',
  measured: (baseline) =>
    `基线已测量${failingCount(baseline) ? `：${failingCount(baseline)} 个测试在基线上就失败，不会算作这次改动引入` : '，所有检查在基线上都通过'}`,
  unavailable: (baseline) => UNAVAILABLE[baseline.reason ?? ''] ?? `没有测量基线（${baseline.reason ?? '未知原因'}）。`,
  contaminated: () => '测量期间工作树发生了变化，这次基线已作废。还原改动后可以重新测量。',
};

// One line for the execution page; `canRemeasure` drives the button.
export const baselineText = (baseline: workspaceTypes.BaselineChecks | null) => {
  if (!baseline) return { text: '', canRemeasure: false };
  const text = BASELINE[baseline.status]?.(baseline) ?? '';
  const canRemeasure = baseline.status === 'contaminated' || (baseline.status === 'unavailable' && baseline.reason !== 'no_checks');
  return { text, canRemeasure };
};

export const evidenceLine = (item: Pick<workspaceTypes.Evidence, 'kind' | 'status' | 'reason' | 'blocking'>) => {
  const status = EVIDENCE_STATUS[item.status] ?? EVIDENCE_STATUS.skipped;
  const parts = [`${stepLabel(item.kind)} ${status.label}`];
  if (item.reason && REASONS[item.reason]) parts.push(REASONS[item.reason]);
  if (!item.blocking) parts.push('仅提示，不阻断');
  return { text: parts.join(' · '), tone: status.tone, icon: status.icon };
};

export const CRITERION_EVIDENCE: Record<workspaceTypes.CriterionStatus, string> = {
  verified: '关联测试通过',
  failed: '关联测试失败',
  missing: '没有找到关联测试',
  unverifiable: '关联测试无法验证',
  manual: '无关联测试，需人工确认',
};

export const attentionText = (item: workspaceTypes.AttentionItem, acceptance: workspaceTypes.AcceptanceCriterion[] = []) => {
  const criterion = (index: number) => `「${acceptance[index]?.text ?? `条件 ${index + 1}`}」`;
  switch (item.code) {
    case 'check_unverifiable':
      return `${stepLabel(item.kind)}无法验证：${REASONS[item.reason ?? ''] ?? item.reason}`;
    case 'preexisting_failures':
      return `${stepLabel(item.kind)}有 ${item.count} 个测试在基线上就失败`;
    case 'no_baseline':
      return `${stepLabel(item.kind)}没有基线，无法区分既有失败`;
    case 'criterion_unverifiable':
      return `${criterion(item.index)}的关联测试无法验证，请人工确认`;
    case 'criterion_manual':
      return `${criterion(item.index)}没有关联测试，请人工确认`;
    case 'criterion_already_passing':
      return `${criterion(item.index)}的关联测试在改动前就已通过，不能证明这次改动有效`;
    default:
      return (item as { code: string }).code;
  }
};

// ========== Execution page ==========

export type CriterionRow = {
  text: string;
  test: string | null;
  status: workspaceTypes.CriterionStatus | null;
  tone: string;
  icon: IconName;
  note: string;
  alreadyPassing: boolean;
};

const CRITERION_TONES: Partial<Record<workspaceTypes.CriterionStatus, string>> = {
  verified: 'verified',
  failed: 'failed',
  missing: 'failed',
  unverifiable: 'unverifiable',
};
const CRITERION_MARKS: Partial<Record<workspaceTypes.CriterionStatus, IconName>> = {
  verified: 'check-circle',
  failed: 'x-circle',
  missing: 'x-circle',
  unverifiable: 'alert',
};

// Acceptance rows; `matched` comes from the last verification run or review, if any.
export const criterionRows = (
  acceptance: workspaceTypes.AcceptanceCriterion[],
  matched: workspaceTypes.CriterionEvidence[] | null | undefined,
): CriterionRow[] => {
  const byText = new Map((matched ?? []).map((entry) => [entry.text, entry]));
  return acceptance.map((criterion) => {
    const result = byText.get(criterion.text);
    // Reviews stored before evidence statuses existed carry only the flags.
    const legacy: workspaceTypes.CriterionStatus | undefined = result
      ? result.manual
        ? 'manual'
        : result.verified
          ? 'verified'
          : result.missing
            ? 'missing'
            : 'failed'
      : undefined;
    const status: workspaceTypes.CriterionStatus | null = result?.status ?? legacy ?? (criterion.test ? null : 'manual');
    return {
      text: criterion.text,
      test: criterion.test ?? null,
      status,
      tone: (status ? CRITERION_TONES[status] : undefined) ?? '',
      icon: (status ? CRITERION_MARKS[status] : undefined) ?? 'circle',
      note: status ? CRITERION_EVIDENCE[status] : '待验证',
      alreadyPassing: result?.alreadyPassing === true,
    };
  });
};

export const REVIEW_REASONS: Record<packageTypes.ReviewReason, string> = {
  no_changes: '相对基线没有任何改动',
  tests_failed: '测试未通过',
  acceptance_tests: '有验收条件的关联测试未通过',
  qa_rejected: 'QA 判定不通过',
  blocker: 'QA 发现了阻断问题',
  criteria_unmet: '有验收条件未满足',
};
export const SEVERITY_LABELS: Record<packageTypes.QaReport['issues'][number]['severity'], string> = { blocker: '阻断', major: '重要', minor: '次要' };
export const CRITERION_LABELS: Record<packageTypes.QaReport['criteria'][number]['status'], string> = { met: '满足', unmet: '未满足', unclear: '无法判断' };
export const CRITERION_ICONS: Record<packageTypes.QaReport['criteria'][number]['status'], IconName> = {
  met: 'check-circle',
  unmet: 'x-circle',
  unclear: 'circle',
};
export const SKIP_LABELS: Record<packageTypes.DiffSkipReason, string> = {
  rename: '重命名',
  outside_workspace: '在工作区外',
  secret: '疑似敏感文件',
  binary: '二进制文件',
  file_limit: '超出文件数上限',
  unreadable: '无法读取',
  too_large: '改动过大',
  budget: '超出审查总量',
};
export const DECISION_LABELS: Record<packageTypes.DeviationResolution['decision'], string> = {
  dismiss: 'Architect 驳回：按原计划继续',
  replan: 'Architect 已重新规划',
};

export const resolutionTitle = (resolution: packageTypes.DeviationResolution) =>
  DECISION_LABELS[resolution.decision] +
  (resolution.afterContest ? '（应你的异议）' : '') +
  (resolution.contested ? ' · 你已提出异议' : '') +
  (resolution.reverted ? ' · 你已撤销' : '');

// git prints several header lines before the hunks; they are neither
// additions nor deletions even when they start with + or -.
const DIFF_META = /^(diff |index |new file |deleted file |old mode |new mode |similarity |rename |Binary files )/;

export type DiffLineKind = 'meta' | 'hunk' | 'add' | 'del' | '';

export const diffLineKind = (line: string): DiffLineKind =>
  DIFF_META.test(line) || line.startsWith('+++') || line.startsWith('---')
    ? 'meta'
    : line.startsWith('@@')
      ? 'hunk'
      : line.startsWith('+')
        ? 'add'
        : line.startsWith('-')
          ? 'del'
          : '';
