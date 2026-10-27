import { test } from 'vitest';
import assert from 'node:assert/strict';

import * as practice from '../../src/main/practice.ts';
import { PROGRAMMING_COURSE } from '../fixtures/builtin_courses.ts';
import type { Grade, ReferenceRun, Review } from '../../src/shared/ipc/packages.ts';

const grade = (overrides: Partial<Grade> = {}): Grade => ({
  id: 'g1',
  status: 'done',
  startedAt: '',
  finishedAt: null,
  error: null,
  diffDigest: 'd1',
  withReference: true,
  report: null,
  costUsd: 0,
  ...overrides,
});

test('a submission digest changes with any path or patch byte', () => {
  const one = practice.submissionDigest([{ path: 'a.ts', patch: '+x' }]);
  assert.equal(one, practice.submissionDigest([{ path: 'a.ts', patch: '+x' }]));
  assert.notEqual(one, practice.submissionDigest([{ path: 'a.ts', patch: '+y' }]));
  assert.notEqual(one, practice.submissionDigest([{ path: 'b.ts', patch: '+x' }]));
  // The separator keeps path and patch from running together.
  assert.notEqual(practice.submissionDigest([{ path: 'ab', patch: 'c' }]), practice.submissionDigest([{ path: 'a', patch: 'bc' }]));
});

test('only a failed grade, or a different submission, is graded again', () => {
  assert.equal(practice.alreadyGraded(null, 'd1'), false);
  assert.equal(practice.alreadyGraded(grade(), 'd1'), true);
  assert.equal(practice.alreadyGraded(grade({ status: 'waiting' }), 'd1'), true);
  assert.equal(practice.alreadyGraded(grade({ status: 'failed' }), 'd1'), false);
  assert.equal(practice.alreadyGraded(grade(), 'd2'), false);
});

test('a long reference is cut at a file boundary and says so', () => {
  const file = (name: string, size: number) => `diff --git a/${name} b/${name}\n+${'x'.repeat(size)}\n`;
  const small = file('a.ts', 10);
  assert.equal(practice.referenceForPrompt(small), small);
  const big = file('a.ts', 40 * 1024) + file('b.ts', 40 * 1024);
  const cut = practice.referenceForPrompt(big);
  assert.match(cut, /^diff --git a\/a\.ts/);
  assert.doesNotMatch(cut, /b\.ts/);
  assert.match(cut, /left out for length/);
});

test('reviewForGrade only reads a finished review, issues with their location', () => {
  assert.equal(practice.reviewForGrade(null), null);
  assert.equal(practice.reviewForGrade({ status: 'running', startedAt: '', finishedAt: null, error: null }), null);
  const done = practice.reviewForGrade({
    status: 'rejected',
    report: { verdict: 'reject', summary: '缺断言', criteria: [], issues: [{ severity: 'blocker', text: '没有断言', file: 'a.ts', line: 3 }] },
  } as never);
  assert.deepEqual(done, { passed: false, summary: '缺断言', issues: ['[blocker] a.ts:3 没有断言'] });
});

test('reference patches are kept per package, with the id made safe for a file name', () => {
  assert.equal(practice.referencePath('/data', 'req-1-wp1'), '/data/references/req-1-wp1.patch');
  assert.equal(practice.referencePath('/data', '../x'), '/data/references/..%2Fx.patch');
});

// A pack whose rubric ids are not the dimension names, as a non-programming pack's are.
const OS_PACK = {
  id: 'os',
  rubric: [
    { id: 'concurrency', label: '并发', description: 'x', dimension: 'thinking' as const },
    { id: 'syscalls', label: '系统调用', description: 'x', dimension: 'writing' as const },
  ],
};
const PACKS = [PROGRAMMING_COURSE, OS_PACK];
const note = (id: string, overrides: object = {}) =>
  ({ id, title: id, category: null, course: null, tags: [], source: null, summary: null, excerpt: `${id} 正文`, ...overrides }) as never;

test('grading reads notes on the changed files first, then categorized ones, at most ten', () => {
  const notes = [
    note('plain'),
    note('style', { category: 'style' }),
    note('file', { source: { file: 'a.ts' } }),
    ...Array.from({ length: 12 }, (_unused, index) => note(`thinking-${index}`, { category: 'thinking' })),
  ];
  const picked = practice.notesForGrade(notes, ['a.ts'], PROGRAMMING_COURSE, PACKS);
  assert.equal(picked.length, practice.MAX_GRADE_NOTES);
  assert.deepEqual(
    picked.slice(0, 3).map((item) => item.title),
    ['file', 'style', 'thinking-0'],
  );
  assert.equal(picked[0].summary, 'file 正文', 'a note without a summary stands in with its excerpt');
  assert.equal(practice.notesForGrade([note('s', { category: 'style', summary: '总结' })], [], PROGRAMMING_COURSE, PACKS)[0].summary, '总结');
  assert.equal(
    picked.some((item) => item.title === 'plain'),
    false,
    'an uncategorized note elsewhere is not relevant',
  );
});

test('grading reads the same file, then the same pack, then other packs on a shared dimension', () => {
  const notes = [
    note('other-style', { category: 'style' }),
    note('other-thinking', { category: 'thinking', summary: '先拆问题' }),
    note('unknown', { category: 'mood', course: 'cooking' }),
    note('os-file', { category: 'syscalls', course: 'os', source: { file: 'k.c' } }),
    note('prog-file', { category: 'style', source: { file: 'k.c' } }),
    note('os-concurrency', { category: 'concurrency', course: 'os' }),
    note('os-uncategorized', { course: 'os' }),
  ];
  const picked = practice.notesForGrade(notes, ['k.c'], OS_PACK, PACKS);
  assert.deepEqual(
    picked.map((item) => [item.title, item.category]),
    [
      ['os-file', 'syscalls'],
      // Another pack's category means nothing here; it is named by its dimension.
      ['prog-file', 'style'],
      ['os-concurrency', 'concurrency'],
      // thinking is a dimension OS has; style is not, and an unknown pack's category maps onto none.
      ['other-thinking', 'thinking'],
    ],
  );
  assert.equal(picked[3].summary, '先拆问题');

  const many = Array.from({ length: 12 }, (_unused, index) => note(`os-${index}`, { category: 'concurrency', course: 'os' }));
  const capped = practice.notesForGrade([note('other', { category: 'thinking' }), ...many], [], OS_PACK, PACKS);
  assert.equal(capped.length, practice.MAX_GRADE_NOTES);
  assert.equal(
    capped.some((item) => item.title === 'other'),
    false,
    'the same pack fills the cap before other packs',
  );

  // From programming, an OS note counts on its dimension even under an id programming does not have.
  assert.deepEqual(practice.notesForGrade([note('os-concurrency', { category: 'concurrency', course: 'os' })], [], PROGRAMMING_COURSE, PACKS), [
    { category: 'thinking', title: 'os-concurrency', summary: 'os-concurrency 正文' },
  ]);
});

// ========== reference lock ==========

const READY_RUN: ReferenceRun = { id: 'r1', status: 'ready', startedAt: '', finishedAt: '', error: null, files: [], costUsd: 0, revealedAt: null };
const check = (status: 'pass' | 'fail', blocking = true) =>
  ({ kind: 'test', stage: 'submit', blocking, baseline: 'measured', status, reason: null, newFailures: [], preexisting: [], fixed: [], run: null }) as const;
const judged = ({ checks = [check('pass')], acceptance = ['verified'] }: { checks?: ReturnType<typeof check>[]; acceptance?: string[] } = {}) =>
  ({
    status: 'rejected',
    startedAt: '',
    finishedAt: '',
    error: null,
    reasons: [],
    attention: [],
    checks,
    verification: null,
    acceptance: acceptance.map((status) => ({ text: 'c', test: 't', status, verified: status === 'verified', manual: false })),
    report: null,
    diff: { files: [], skipped: [], outOfScope: [] },
    costUsd: 0,
  }) as unknown as Review;

test('the reference stays locked before a submission and while its tests do not all pass', () => {
  assert.deepEqual(practice.referenceLock({ referenceRun: READY_RUN, review: null }, null), { unlocked: false, reason: 'not_submitted' });
  assert.deepEqual(practice.referenceLock({ referenceRun: READY_RUN, review: { status: 'running', startedAt: '', finishedAt: null, error: null } }, null), {
    unlocked: false,
    reason: 'not_submitted',
  });
  const notPassed = { unlocked: false, reason: 'tests_not_passed' };
  // A blocking check failed (a lab's hidden tests are one), or a linked test did not pass.
  assert.deepEqual(practice.referenceLock({ referenceRun: READY_RUN, review: judged({ checks: [check('pass'), check('fail')] }) }, null), notPassed);
  assert.deepEqual(practice.referenceLock({ referenceRun: READY_RUN, review: judged({ acceptance: ['verified', 'missing'] }) }, null), notPassed);
  assert.deepEqual(practice.referenceLock({ referenceRun: READY_RUN, review: judged({ checks: [], acceptance: [] }) }, null), notPassed, 'nothing ran');
  // QA's own pass is not a test.
  assert.deepEqual(
    practice.referenceLock({ referenceRun: READY_RUN, review: { ...judged({ checks: [check('fail')] }), status: 'passed' } as Review }, null),
    notPassed,
  );
  assert.equal(practice.referenceLock({ referenceRun: { ...READY_RUN, status: 'running' }, review: judged() }, null), null, 'no ready reference');
});

test('the reference opens once every test passed, or the hints were used up to L5, and stays open once read', () => {
  assert.deepEqual(practice.referenceLock({ referenceRun: READY_RUN, review: judged() }, null), { unlocked: true, reason: 'tests_passed' });
  // An advisory check does not hold it back.
  assert.deepEqual(practice.referenceLock({ referenceRun: READY_RUN, review: judged({ checks: [check('pass'), check('fail', false)] }) }, null), {
    unlocked: true,
    reason: 'tests_passed',
  });
  assert.deepEqual(practice.referenceLock({ referenceRun: READY_RUN, review: null }, 5), { unlocked: true, reason: 'hints_used' });
  assert.deepEqual(practice.referenceLock({ referenceRun: READY_RUN, review: null }, 4), { unlocked: false, reason: 'not_submitted' });
  assert.deepEqual(practice.referenceLock({ referenceRun: { ...READY_RUN, revealedAt: 'x' }, review: judged({ checks: [check('fail')] }) }, null), {
    unlocked: true,
    reason: 'revealed',
  });
  // The highest level opened at any step of this claim counts.
  const use = (stepIndex: number, level: number) => ({ stepIndex, level, at: '2026-10-27T00:00:00Z', filtered: false });
  assert.equal(practice.usedHintLevel({ hints: [] }), null);
  assert.equal(practice.usedHintLevel({ hints: [use(0, 1), use(0, 2), use(1, 1)] }), 2);
  assert.equal(practice.usedHintLevel({ hints: [use(0, 1), use(2, 5)] }), 5);
});
