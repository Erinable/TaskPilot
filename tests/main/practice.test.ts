import { test } from 'vitest';
import assert from 'node:assert/strict';

import * as practice from '../../src/main/practice.ts';
import { PROGRAMMING_COURSE } from '../fixtures/builtin_courses.ts';
import type { Grade } from '../../src/shared/ipc/packages.ts';

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
