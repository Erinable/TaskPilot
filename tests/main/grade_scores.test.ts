// The two score formulas (src/main/grade_scores.ts), one deduction or
// share at a time, and their bounds.
import { test } from 'vitest';
import assert from 'node:assert/strict';

import * as scores from '../../src/main/grade_scores.ts';
import type { Review, ReviewCheck } from '../../src/shared/ipc/packages.ts';
import type { CriterionEvidence } from '../../src/shared/ipc/workspace.ts';

// A blocking test check that ran `total` tests, `passed` of them passing.
const check = (passed: number, total: number, overrides: Partial<ReviewCheck> = {}): ReviewCheck => ({
  kind: 'test',
  stage: 'submit',
  blocking: true,
  baseline: 'measured',
  status: passed === total ? 'pass' : 'fail',
  reason: null,
  newFailures: [],
  preexisting: [],
  fixed: [],
  run: {
    kind: 'test',
    command: 'npm test',
    exitCode: passed === total ? 0 : 1,
    timedOut: false,
    durationMs: 1,
    summary: { total, passed, failed: total - passed, skipped: 0, ok: passed === total },
    report: null,
    failing: [],
    outputTail: null,
  },
  ...overrides,
});

const criterion = (status: CriterionEvidence['status'], test: string | null = 'a test'): CriterionEvidence => ({
  text: 'criterion',
  ...(test ? { test } : {}),
  status,
  verified: status === 'verified',
  manual: false,
});

const review = (status: 'passed' | 'rejected', checks: ReviewCheck[], acceptance: CriterionEvidence[] = []): Review => ({
  status,
  error: null,
  startedAt: '',
  finishedAt: '',
  reasons: [],
  attention: [],
  checks,
  verification: null,
  acceptance,
  report: null,
  diff: { files: [], skipped: [], outOfScope: [] },
  costUsd: 0,
});

const RUBRIC = [{ id: 'thinking' }, { id: 'writing' }, { id: 'style' }];
const TOP = { thinking: 4, writing: 4, style: 4 };
const quality = (input: Partial<Parameters<typeof scores.qualityScore>[0]>) =>
  scores.qualityScore({ review: review('passed', [check(4, 4)]), rubric: RUBRIC, levels: TOP, ...input });
const independence = (input: Partial<Parameters<typeof scores.independenceScore>[0]>) =>
  scores.independenceScore({ hints: [], reference: null, similarity: 0, ...input });

test('quality: everything passed, QA accepted and every rubric item at level 4 is 100', () => {
  const result = quality({});
  assert.equal(result.quality, 100);
  assert.deepEqual(result.signals, { tests: { passed: 4, total: 4, points: 40 }, qa: { passed: true, points: 20 }, rubric: { points: 40 } });
});

test('quality: tests and acceptance give 40 by the share that passed, linked criteria included', () => {
  // 3 of 4 tests and 1 of 2 linked criteria: 4 of 6.
  const mixed = review('rejected', [check(3, 4)], [criterion('verified'), criterion('failed'), criterion('manual', null)]);
  assert.deepEqual(quality({ review: mixed }).signals.tests, { passed: 4, total: 6, points: 27 });
  // A blocking check with no test count is one unit; a non-blocking one is not counted.
  const noCount = review('rejected', [check(0, 0, { status: 'fail' }), check(0, 3, { blocking: false })]);
  assert.deepEqual(quality({ review: noCount }).signals.tests, { passed: 0, total: 1, points: 0 });
  const errored = review('passed', [check(1, 1, { status: 'pass', run: { error: { code: 'x', message: '' } } })]);
  assert.deepEqual(quality({ review: errored }).signals.tests, { passed: 1, total: 1, points: 40 });
  // Nothing to run, or no finished review: nothing passed.
  assert.deepEqual(quality({ review: review('passed', []) }).signals.tests, { passed: 0, total: 0, points: 0 });
  assert.deepEqual(quality({ review: null }).signals.tests, { passed: 0, total: 0, points: 0 });
});

test('quality: QA gives 20 only when it accepted', () => {
  assert.deepEqual(quality({ review: review('rejected', [check(4, 4)]) }).signals.qa, { passed: false, points: 0 });
  assert.equal(quality({ review: review('rejected', [check(4, 4)]) }).quality, 80);
});

test('quality: the rubric gives 40 by the mean level, 1 counting nothing and a missing level as 1', () => {
  assert.equal(quality({ levels: { thinking: 1, writing: 1, style: 1 } }).signals.rubric.points, 0);
  // (3 + 2 + 1) / 9 of 40.
  assert.equal(quality({ levels: { thinking: 4, writing: 3, style: 2 } }).signals.rubric.points, 27);
  assert.equal(quality({ levels: { thinking: 4 } }).signals.rubric.points, 13);
  assert.equal(quality({ rubric: [] }).signals.rubric.points, 0);
  // Lowest possible: nothing passed, QA rejected, every level 1.
  assert.equal(quality({ review: review('rejected', [check(0, 4)]), levels: {} }).quality, 0);
});

test('independence: no help used is 100', () => {
  assert.deepEqual(independence({}), {
    independence: 100,
    signals: { hints: [], reference: { beforePass: false, deduction: 0 }, similarity: { ratio: 0, deduction: 0 } },
  });
});

test('independence: L1 and L2 cost nothing, L3 5, L4 10, L5 20', () => {
  for (const [level, expected] of [
    [1, 100],
    [2, 100],
    [3, 95],
    [4, 90],
    [5, 80],
  ])
    assert.equal(independence({ hints: [{ level }] }).independence, expected, `L${level}`);
  assert.equal(independence({ hints: [1, 2, 3, 4, 5].map((level) => ({ level })) }).independence, 65);
});

test('independence: a level used more than once, at the same or another step, is deducted once', () => {
  const result = independence({ hints: [{ level: 3 }, { level: 3 }, { level: 4 }, { level: 3 }] });
  assert.deepEqual(result.signals.hints, [
    { level: 3, deduction: 5 },
    { level: 4, deduction: 10 },
  ]);
  assert.equal(result.independence, 85);
});

test('independence: the reference read before the tests all passed costs 40, read after costs nothing', () => {
  const before = independence({ reference: { revealedAt: '2026-10-27T00:00:00Z', revealedWith: 'hints_used' } });
  assert.deepEqual([before.independence, before.signals.reference], [60, { beforePass: true, deduction: 40 }]);
  assert.equal(independence({ reference: { revealedAt: '2026-10-27T00:00:00Z', revealedWith: 'tests_passed' } }).independence, 100);
  // Not read, or read before TaskPilot kept why: not counted.
  assert.equal(independence({ reference: { revealedAt: null, revealedWith: 'hints_used' } }).independence, 100);
  assert.equal(independence({ reference: { revealedAt: '2026-10-27T00:00:00Z' } }).independence, 100);
});

test('independence: similarity costs its share of 30, clamped to 0..1', () => {
  assert.deepEqual(independence({ similarity: 0.5 }).signals.similarity, { ratio: 0.5, deduction: 15 });
  assert.equal(independence({ similarity: 1 }).independence, 70);
  assert.equal(independence({ similarity: 2 }).independence, 70);
  assert.equal(independence({ similarity: -1 }).independence, 100);
});

test('independence: never below 0', () => {
  const everything = independence({
    hints: [3, 4, 5].map((level) => ({ level })),
    reference: { revealedAt: '2026-10-27T00:00:00Z', revealedWith: 'hints_used' },
    similarity: 1,
  });
  // 35 + 40 + 30 = 105 deducted.
  assert.equal(everything.independence, 0);
});

test('gradeScores puts both scores and every signal together', () => {
  const result = scores.gradeScores({
    review: review('passed', [check(2, 2)]),
    rubric: RUBRIC,
    levels: TOP,
    hints: [{ level: 4 }],
    reference: null,
    similarity: 0.2,
  });
  assert.deepEqual([result.quality, result.independence], [100, 84]);
  assert.deepEqual(Object.keys(result.signals), ['tests', 'qa', 'rubric', 'hints', 'reference', 'similarity']);
});
