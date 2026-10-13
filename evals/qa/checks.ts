// Deterministic checks on one QA review. They compare the outcome with what
// the case planted; the judge (run.ts) scores how useful the issues are.
import type { CheckResult } from '../shared/harness.ts';
import type { QaCase } from './cases.ts';
import type { ReviewResult } from '../../src/main/agents/pipeline.ts';

export const check = (testCase: Pick<QaCase, 'expect'>, review: Pick<ReviewResult, 'passed' | 'reasons' | 'report'>): Record<string, CheckResult> => {
  const { expect } = testCase;
  const report = review.report;
  const issues = report?.issues ?? [];
  const results: Record<string, CheckResult> = {
    outcome: {
      pass: review.passed === (expect.verdict === 'pass'),
      detail: `expected ${expect.verdict}, got ${review.passed ? 'pass' : 'reject'} (${review.reasons.join(', ') || 'no reasons'})`,
    },
    // A review the model never saw (no changes, failing tests) proves nothing.
    reviewed: { pass: report !== null, detail: report ? 'model reviewed the diff' : 'decided without the model' },
  };
  if (expect.verdict === 'pass') {
    results.noFalseBlocker = {
      pass: !issues.some((issue) => issue.severity === 'blocker' || issue.severity === 'major'),
      detail: issues.map((issue) => `[${issue.severity}] ${issue.text}`).join(' | ') || 'no issues',
    };
  }
  if (expect.issueFiles?.length) {
    const named = new Set(issues.map((issue) => issue.file).filter(Boolean));
    const missing = expect.issueFiles.filter((file) => !named.has(file));
    results.locatesBug = { pass: missing.length === 0, detail: missing.length ? `no issue names ${missing.join(', ')}` : 'issue names the file' };
  }
  if (expect.serious) {
    results.serious = {
      pass: issues.some((issue) => issue.severity === 'blocker' || issue.severity === 'major'),
      detail: issues.map((issue) => issue.severity).join(', ') || 'no issues',
    };
  }
  if (expect.unmet?.length) {
    const unmet = new Set((report?.criteria ?? []).filter((criterion) => criterion.status === 'unmet').map((criterion) => criterion.index));
    const missed = expect.unmet.filter((index) => !unmet.has(index));
    results.criteriaJudged = { pass: missed.length === 0, detail: missed.length ? `criteria ${missed.join(', ')} not marked unmet` : 'unmet criteria marked' };
  }
  return results;
};
