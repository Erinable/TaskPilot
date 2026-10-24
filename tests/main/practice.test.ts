import { test } from 'vitest';
import assert from 'node:assert/strict';

import * as practice from '../../src/main/practice.ts';
import type { Grade } from '../../src/shared/ipc_types.ts';

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
