// The two scores of a practised submission, worked out by TaskPilot from
// what it recorded; the model only gives the rubric levels.
//
// Quality, 0–100:
//   tests and acceptance  40 × the share that passed: each blocking check's
//                         tests (a check with no test count is one unit) and
//                         each acceptance criterion with a linked test
//   QA's verdict          20 when QA accepted, else 0
//   rubric                40 × the mean of (level − 1) / 3, a level 1–4 per item
// Independence, 0–100, from 100 down:
//   hints                 L1 / L2 nothing, L3 5, L4 10, L5 20; each level once
//                         however often or at however many steps it was opened
//   reference             40 when it was first read before the tests all passed
//                         (opened by the hint ladder; a reference read before
//                         TaskPilot kept why is not counted)
//   similarity            30 × the share of the submission's added lines that
//                         match code TaskPilot showed (./hint_leak.ts copiedShare)
//   never below 0
// Only help used inside TaskPilot can be counted.
//
// [人工决策-2026-10-27 00:36:21] 项目模式分开打质量分和独立完成度两个分，分数由 TaskPilot 按公式算，模型只给 rubric 的 levels。
// [人工决策-2026-10-27 00:51:12] 独立完成度：L3 扣 5、L4 扣 10、L5 扣 20（同级只扣一次），测试全过前看了参考答案扣 40，雷同比例 × 30。
import { MAX_RUBRIC_LEVEL } from '../agents/tutor_grade.ts';
import type { GradeScores, ReferenceRun, Review } from '../../shared/ipc/packages.ts';
import type { HintUse } from '../../shared/hint_ladder.ts';
import type { RubricItem } from '../../shared/course_pack.ts';

const TESTS_POINTS = 40;
const QA_POINTS = 20;
const RUBRIC_POINTS = 40;
const HINT_DEDUCTIONS: Record<number, number> = { 1: 0, 2: 0, 3: 5, 4: 10, 5: 20 };
const REFERENCE_DEDUCTION = 40;
const SIMILARITY_POINTS = 30;

type Finished = Review & { status: 'passed' | 'rejected' };

const finished = (review: Review | null): review is Finished => review?.status === 'passed' || review?.status === 'rejected';

// Tests and linked acceptance criteria that passed in the review, out of all of them.
export const testUnits = (review: Review | null): { passed: number; total: number } => {
  if (!finished(review)) return { passed: 0, total: 0 };
  let passed = 0;
  let total = 0;
  for (const check of review.checks.filter((item) => item.blocking)) {
    const summary = check.run && !('error' in check.run) && check.run.summary.total > 0 ? check.run.summary : null;
    if (summary) {
      passed += summary.passed;
      total += summary.total;
    } else {
      passed += check.status === 'pass' ? 1 : 0;
      total += 1;
    }
  }
  const linked = review.acceptance.filter((criterion) => criterion.test);
  return { passed: passed + linked.filter((criterion) => criterion.status === 'verified').length, total: total + linked.length };
};

// Each rubric item's level counts the same; an item without one counts as 1.
const rubricPoints = (rubric: Pick<RubricItem, 'id'>[], levels: Record<string, number>): number => {
  if (!rubric.length) return 0;
  const sum = rubric.reduce((total, item) => total + ((levels[item.id] ?? 1) - 1), 0);
  return Math.round((RUBRIC_POINTS * sum) / ((MAX_RUBRIC_LEVEL - 1) * rubric.length));
};

export const qualityScore = ({
  review,
  rubric,
  levels,
}: {
  review: Review | null;
  rubric: Pick<RubricItem, 'id'>[];
  levels: Record<string, number>;
}): Pick<GradeScores, 'quality'> & { signals: Pick<GradeScores['signals'], 'tests' | 'qa' | 'rubric'> } => {
  const units = testUnits(review);
  const tests = { ...units, points: units.total ? Math.round((TESTS_POINTS * units.passed) / units.total) : 0 };
  const qa = { passed: review?.status === 'passed', points: review?.status === 'passed' ? QA_POINTS : 0 };
  const rubricScore = { points: rubricPoints(rubric, levels) };
  return { quality: tests.points + qa.points + rubricScore.points, signals: { tests, qa, rubric: rubricScore } };
};

export const independenceScore = ({
  hints,
  reference,
  similarity,
}: {
  hints: Pick<HintUse, 'level'>[];
  reference: Pick<ReferenceRun, 'revealedAt' | 'revealedWith'> | null;
  // The share of the submission matching code TaskPilot showed, 0 to 1.
  similarity: number;
}): Pick<GradeScores, 'independence'> & { signals: Pick<GradeScores['signals'], 'hints' | 'reference' | 'similarity'> } => {
  const levels = [...new Set(hints.map((use) => use.level))].sort((a, b) => a - b);
  const hintSignals = levels.map((level) => ({ level, deduction: HINT_DEDUCTIONS[level] ?? 0 }));
  const beforePass = Boolean(reference?.revealedAt) && reference?.revealedWith === 'hints_used';
  const ratio = Math.min(1, Math.max(0, similarity));
  const signals = {
    hints: hintSignals,
    reference: { beforePass, deduction: beforePass ? REFERENCE_DEDUCTION : 0 },
    similarity: { ratio, deduction: Math.round(SIMILARITY_POINTS * ratio) },
  };
  const deducted = hintSignals.reduce((total, hint) => total + hint.deduction, 0) + signals.reference.deduction + signals.similarity.deduction;
  return { independence: Math.max(0, 100 - deducted), signals };
};

export const gradeScores = (input: Parameters<typeof qualityScore>[0] & Parameters<typeof independenceScore>[0]): GradeScores => {
  const quality = qualityScore(input);
  const independence = independenceScore(input);
  return { quality: quality.quality, independence: independence.independence, signals: { ...quality.signals, ...independence.signals } };
};
