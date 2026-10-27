import { onTestFinished, test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import * as mastery from '../../src/main/mastery_store.ts';
import type { Review, ReviewCheck } from '../../src/shared/ipc/packages.ts';

const dir = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tp-mastery-'));
  onTestFinished(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
};

// A blocking test check that ran `total` tests, `passed` of them passing.
const check = (passed: number, total: number): ReviewCheck => ({
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
    command: 'make grade',
    exitCode: passed === total ? 0 : 1,
    timedOut: false,
    durationMs: 1,
    summary: { total, passed, failed: total - passed, skipped: 0, ok: passed === total },
    report: null,
    failing: [],
    outputTail: null,
  },
});

const review = (status: 'passed' | 'rejected', checks: ReviewCheck[]): Review => ({
  status,
  error: null,
  startedAt: '2026-10-27T00:00:00Z',
  finishedAt: '2026-10-27T00:01:00Z',
  reasons: [],
  attention: [],
  checks,
  verification: null,
  acceptance: [],
  report: null,
  diff: { files: [], skipped: [], outOfScope: [] },
  costUsd: 0,
});

const report = { comments: [{ category: 'concept' }, { category: 'mechanism' }, { category: 'concept' }], errorTags: ['off-by-one'] };

const submission = (overrides: Partial<mastery.GradedSubmission> = {}): mastery.GradedSubmission => ({
  mode: 'practice',
  course: 'os',
  concepts: ['round-robin'],
  packageId: 'lab-rr',
  repoId: 'repo1',
  diffDigest: 'd1',
  review: review('passed', [check(3, 3)]),
  report: report as mastery.GradedSubmission['report'],
  at: '2026-10-27T00:02:00.000Z',
  ...overrides,
});

test('pass needs every test passed and QA accepting; partial needs more than half the tests', () => {
  assert.equal(mastery.attemptResult(review('passed', [check(3, 3)])), 'pass');
  // QA rejected although every test passed: more than half passed.
  assert.equal(mastery.attemptResult(review('rejected', [check(3, 3)])), 'partial');
  // Hidden tests count with the public ones: 3 + 1 of 3 + 2.
  assert.equal(mastery.attemptResult(review('rejected', [check(3, 3), check(1, 2)])), 'partial');
  assert.equal(mastery.attemptResult(review('passed', [check(2, 4)])), 'fail', 'exactly half is not more than half');
  assert.equal(mastery.attemptResult(review('rejected', [check(1, 4)])), 'fail');
  // Nothing ran: no test passed.
  assert.equal(mastery.attemptResult(review('passed', [])), 'fail');
  assert.equal(mastery.attemptResult(null), 'fail');
  // Advisory checks and checks that could not run do not count.
  const advisory = { ...check(0, 5), blocking: false };
  const broken = { ...check(0, 0), run: { error: { code: 'x', message: 'x' } } };
  assert.equal(mastery.attemptResult(review('rejected', [check(2, 3), advisory, broken])), 'partial');
});

test('error types are the comment categories then the error tags, each once', () => {
  assert.deepEqual(mastery.errorTypesOf(report as Parameters<typeof mastery.errorTypesOf>[0]), ['concept', 'mechanism', 'off-by-one']);
  // Grades from before error tags have none.
  assert.deepEqual(mastery.errorTypesOf({ comments: [] }), []);
});

test('a graded submission writes one attempt per concept, and survives a reload', async () => {
  const configDir = await dir();
  const store = await new mastery.MasteryStore(configDir).load();
  assert.deepEqual(await store.record(submission({ concepts: ['round-robin', 'priority-sched', 'round-robin'] })), ['round-robin', 'priority-sched']);
  const record = store.get('os', 'round-robin')!;
  assert.deepEqual(record.attempts, [
    {
      at: '2026-10-27T00:02:00.000Z',
      packageId: 'lab-rr',
      repoId: 'repo1',
      result: 'pass',
      independence: null,
      errorTypes: ['concept', 'mechanism', 'off-by-one'],
    },
  ]);
  assert.deepEqual(record.totals, { attempts: 1, pass: 1, partial: 0, fail: 0 });
  assert.deepEqual(record.errorCounts, [
    { type: 'off-by-one', count: 1 },
    { type: 'mechanism', count: 1 },
    { type: 'concept', count: 1 },
  ]);
  assert.ok(store.get('os', 'priority-sched'));
  await store.flush();
  const saved = JSON.parse(await fs.readFile(path.join(configDir, mastery.MASTERY_FILENAME), 'utf8'));
  assert.equal(saved.version, 1);
  assert.deepEqual((await new mastery.MasteryStore(configDir).load()).get('os', 'round-robin'), record);
});

test('the same submission of the same package is written once; a new diff or another repository counts again', async () => {
  const store = await new mastery.MasteryStore(await dir()).load();
  await store.record(submission());
  assert.deepEqual(await store.record(submission({ at: '2026-10-27T01:00:00.000Z' })), [], 'a regrade of the same diff');
  assert.equal(store.get('os', 'round-robin')!.totals.attempts, 1);
  await store.record(submission({ diffDigest: 'd2', review: review('rejected', [check(0, 3)]) }));
  await store.record(submission({ repoId: 'repo2' }));
  const record = store.get('os', 'round-robin')!;
  assert.deepEqual(
    record.attempts.map((attempt) => [attempt.repoId, attempt.result]),
    [
      ['repo1', 'pass'],
      ['repo1', 'fail'],
      ['repo2', 'pass'],
    ],
  );
});

test('de-duplication is kept across a reload', async () => {
  const configDir = await dir();
  const store = await new mastery.MasteryStore(configDir).load();
  await store.record(submission());
  await store.flush();
  const reloaded = await new mastery.MasteryStore(configDir).load();
  assert.deepEqual(await reloaded.record(submission()), []);
  assert.equal(reloaded.get('os', 'round-robin')!.totals.attempts, 1);
});

test('only the last 20 attempts are kept in detail; totals and error counts cover every one', async () => {
  const store = await new mastery.MasteryStore(await dir()).load();
  for (let index = 0; index < 25; index += 1) {
    const result = index % 5 === 0 ? review('rejected', [check(2, 3)]) : review('passed', [check(3, 3)]);
    await store.record(submission({ diffDigest: `d${index}`, packageId: `p${index}`, review: result }));
  }
  const record = store.get('os', 'round-robin')!;
  assert.equal(record.attempts.length, mastery.MAX_ATTEMPTS);
  assert.deepEqual([record.attempts[0].packageId, record.attempts.at(-1)!.packageId], ['p5', 'p24'], 'the oldest go first');
  assert.deepEqual(record.totals, { attempts: 25, pass: 20, partial: 5, fail: 0 });
  assert.deepEqual(
    record.errorCounts.find((entry) => entry.type === 'concept'),
    { type: 'concept', count: 25 },
  );
});

test('error counts keep the top 10, most frequent first', () => {
  let record: mastery.MasteryRecord = { course: 'os', conceptId: 'x', attempts: [], totals: { attempts: 0, pass: 0, partial: 0, fail: 0 }, errorCounts: [] };
  const attempt = (errorTypes: string[]): mastery.MasteryAttempt => ({ at: '', packageId: 'p', repoId: 'r', result: 'fail', independence: null, errorTypes });
  record = mastery.addAttempt(record, attempt(Array.from({ length: 12 }, (_, index) => `tag-${String(index).padStart(2, '0')}`)));
  record = mastery.addAttempt(record, attempt(['tag-11', 'tag-10']));
  assert.equal(record.errorCounts.length, mastery.MAX_ERROR_TYPES);
  // Equal counts keep the newest first, so the oldest two of the first twelve were cut.
  assert.deepEqual(record.errorCounts.slice(0, 3), [
    { type: 'tag-10', count: 2 },
    { type: 'tag-11', count: 2 },
    { type: 'tag-09', count: 1 },
  ]);
  assert.equal(record.errorCounts.at(-1)!.type, 'tag-02');
  // A type cut once comes back when it is seen again.
  record = mastery.addAttempt(record, attempt(['tag-00']));
  assert.deepEqual(record.errorCounts[2], { type: 'tag-00', count: 1 });
});

test('a package done by Coding Agent, or one without concepts, writes nothing', async () => {
  const configDir = await dir();
  const store = await new mastery.MasteryStore(configDir).load();
  assert.deepEqual(await store.record(submission({ mode: 'ai' })), []);
  assert.deepEqual(await store.record(submission({ mode: 'self' })), []);
  assert.deepEqual(await store.record(submission({ mode: null })), []);
  assert.deepEqual(await store.record(submission({ concepts: [] })), []);
  // An id that is not a concept id is never written.
  assert.deepEqual(await store.record(submission({ concepts: ['Not An Id'] })), []);
  assert.deepEqual(store.list(), []);
  await assert.rejects(fs.stat(path.join(configDir, mastery.MASTERY_FILENAME)), { code: 'ENOENT' }, 'nothing written at all');
});

test('a broken mastery.json starts empty instead of failing startup', async () => {
  const configDir = await dir();
  await fs.writeFile(path.join(configDir, mastery.MASTERY_FILENAME), '{not json');
  assert.deepEqual((await new mastery.MasteryStore(configDir).load()).list(), []);
  await fs.writeFile(path.join(configDir, mastery.MASTERY_FILENAME), JSON.stringify({ records: [{ course: 'os' }, null], seen: [1] }));
  assert.deepEqual((await new mastery.MasteryStore(configDir).load()).list(), []);
});
