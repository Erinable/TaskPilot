// The review channels (src/main/ipc/mastery.ts): notes that carry concepts
// are due by the business day (Asia/Shanghai here), and the learner's
// verdict moves them through the Leitner boxes, saved in mastery.json.
import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { CHANNELS } from '../../../src/shared/ipc_channels.ts';
import { MASTERY_FILENAME, MasteryStore } from '../../../src/main/courses/mastery_store.ts';
import * as fixtures from './harness.ts';

afterEach(() => {
  vi.useRealTimers();
});

// Only Date is faked, so the stores' file writes and timers run as usual.
const at = (iso: string) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(iso));
};

const note = (h, title: string, concepts: string[]) =>
  h.notes.create({ title, body: `${title}。`, category: 'mechanism', course: 'os', concepts, tags: [], source: null });

test('mastery: a note with concepts is due the next business day, by Shanghai midnight rather than UTC midnight', async () => {
  // 2026-10-27 23:30 UTC is 2026-10-28 07:30 in Shanghai.
  at('2026-10-27T23:30:00.000Z');
  const h = await fixtures.harness();
  await note(h, 'RR 入队顺序', ['round-robin']);
  await note(h, '没有知识点', []);
  let list = (await h.call(CHANNELS.masteryReviews)).data;
  assert.deepEqual([list.today, list.due, list.total], ['2026-10-28', [], 1]);
  // 15:59 UTC on the 28th is still the 28th in Shanghai.
  at('2026-10-28T15:59:00.000Z');
  assert.deepEqual((await h.call(CHANNELS.masteryReviews)).data.due, []);
  assert.equal((await h.call(CHANNELS.masteryReview, 'RR 入队顺序.md', true)).error.code, 'not_due');
  // 16:00 UTC is midnight of the 29th in Shanghai, though still the 28th in UTC.
  at('2026-10-28T16:00:00.000Z');
  list = (await h.call(CHANNELS.masteryReviews)).data;
  assert.equal(list.today, '2026-10-29');
  assert.deepEqual(list.due, [{ noteId: 'RR 入队顺序.md', box: 1, dueDay: '2026-10-29', title: 'RR 入队顺序', concepts: ['round-robin'] }]);
});

test('mastery: remembered moves a note up a box, forgotten back to box 1, and the schedule is kept in mastery.json', async () => {
  at('2026-10-27T02:00:00.000Z');
  const h = await fixtures.harness();
  await note(h, 'RR 入队顺序', ['round-robin']);
  assert.equal((await h.call(CHANNELS.masteryReview, '没有这条.md', true)).error.code, 'not_reviewable');
  assert.equal((await h.call(CHANNELS.masteryReview, 'RR 入队顺序.md', 'yes')).error.code, 'invalid_argument');
  at('2026-10-28T02:00:00.000Z');
  assert.deepEqual((await h.call(CHANNELS.masteryReview, 'RR 入队顺序.md', true)).data, { noteId: 'RR 入队顺序.md', box: 2, dueDay: '2026-10-31' });
  assert.deepEqual((await h.call(CHANNELS.masteryReviews)).data.due, []);
  at('2026-10-31T02:00:00.000Z');
  assert.deepEqual((await h.call(CHANNELS.masteryReview, 'RR 入队顺序.md', false)).data, { noteId: 'RR 入队顺序.md', box: 1, dueDay: '2026-11-01' });
  await h.mastery.flush();
  const saved = JSON.parse(await fs.readFile(path.join(h.configDir, MASTERY_FILENAME), 'utf8'));
  assert.deepEqual(saved.reviews, [{ noteId: 'RR 入队顺序.md', box: 1, dueDay: '2026-11-01' }]);
  assert.deepEqual([...(await new MasteryStore(h.configDir).load()).reviews().values()], saved.reviews);
});

test('mastery: a deleted note’s schedule is dropped at the next review', async () => {
  at('2026-10-27T02:00:00.000Z');
  const h = await fixtures.harness();
  await note(h, '甲', ['round-robin']);
  await note(h, '乙', ['fcfs']);
  at('2026-10-28T02:00:00.000Z');
  await h.call(CHANNELS.masteryReview, '甲.md', true);
  await h.notes.remove('甲.md');
  await h.call(CHANNELS.masteryReview, '乙.md', true);
  assert.deepEqual([...h.mastery.reviews().keys()], ['乙.md']);
});

// One graded submission of `conceptId` in the os pack.
const attempt = (h, conceptId: string, passed: boolean, digest: string, { independence = 95, errorTags = [] as string[] } = {}) =>
  h.mastery.record({
    mode: 'practice',
    course: 'os',
    concepts: [conceptId],
    packageId: `lab-${conceptId}`,
    repoId: 'repo1',
    diffDigest: digest,
    review: {
      status: passed ? 'passed' : 'rejected',
      error: null,
      startedAt: '2026-10-27T01:00:00.000Z',
      finishedAt: '2026-10-27T01:05:00.000Z',
      reasons: [],
      attention: [],
      checks: [
        {
          kind: 'test',
          stage: 'submit',
          blocking: true,
          baseline: 'clean',
          status: passed ? 'pass' : 'fail',
          reason: null,
          newFailures: [],
          preexisting: [],
          fixed: [],
          run: {
            kind: 'test',
            command: 'make grade',
            exitCode: 0,
            timedOut: false,
            durationMs: 1,
            summary: { total: 3, passed: passed ? 3 : 1, failed: passed ? 0 : 2, skipped: 0, ok: passed },
            report: null,
            failing: [],
            outputTail: null,
          },
        },
      ],
      verification: null,
      acceptance: [],
      report: null,
      diff: { files: [], skipped: [], outOfScope: [] },
      costUsd: 0,
    },
    report: { comments: [], errorTags },
    independence,
    difficulty: 'easy',
    hintLevel: 3,
    at: `2026-10-27T0${digest.length}:00:00.000Z`,
  });

test('mastery:course: the os skeleton with each concept’s standing and attempts, and the top error types (the CARM-33 example)', async () => {
  const h = await fixtures.harness();
  // round-robin: rejected on a hidden test, then passed with L3 (independence 95).
  await attempt(h, 'round-robin', false, 'd1', { errorTags: ['missed-edge-case'] });
  await attempt(h, 'round-robin', true, 'd22', { errorTags: ['missed-edge-case'] });
  // fcfs: passed twice, mastered.
  await attempt(h, 'fcfs', true, 'd3');
  await attempt(h, 'fcfs', true, 'd44', { errorTags: ['naming'] });
  const { data, error } = await h.call(CHANNELS.masteryCourse, 'os');
  assert.equal(error, undefined, JSON.stringify(error));
  assert.equal(data.course.id, 'os');
  const byId = new Map<string, any>(data.concepts.map((concept) => [concept.id, concept]));
  assert.ok(byId.size > 5, 'every concept of the skeleton is listed');
  assert.deepEqual(
    ['process-state', 'fcfs', 'round-robin', 'priority-sched'].map((id) => byId.get(id).state),
    ['new', 'mastered', 'passed', 'new'],
  );
  assert.deepEqual(byId.get('round-robin').totals, { attempts: 2, pass: 1, partial: 0, fail: 1 });
  assert.deepEqual(
    byId.get('round-robin').attempts.map((entry) => [entry.result, entry.packageId, entry.independence]),
    [
      ['pass', 'lab-round-robin', 95],
      ['fail', 'lab-round-robin', 95],
    ],
    'newest first',
  );
  assert.deepEqual(byId.get('round-robin').prerequisites, ['fcfs', 'timer-interrupt'], 'from the skeleton, for the graph');
  assert.deepEqual(data.errorTypes[0], { type: 'missed-edge-case', count: 2 });
  assert.ok(data.errorTypes.length <= 5);
  // The harness's repository is a project, not one of os's lab repositories.
  assert.deepEqual(data.repositories, []);
  await fs.writeFile(
    path.join(h.root, 'taskpilot.toml'),
    'course = "os"\n\n[[labs]]\nid = "round-robin"\nstage = 1\ndir = "labs/01-round-robin"\nconcepts = ["round-robin"]\n',
  );
  assert.deepEqual((await h.call(CHANNELS.masteryCourse, 'os')).data.repositories, [
    { id: h.repositories.current!.id, name: path.basename(h.root), labs: 1, current: true },
  ]);
  // Without an id: the pack in use (programming, which has no skeleton).
  await fs.rm(path.join(h.root, 'taskpilot.toml'));
  const inUse = (await h.call(CHANNELS.masteryCourse)).data;
  assert.deepEqual([inUse.course.id, inUse.concepts, inUse.errorTypes, inUse.repositories], ['programming', [], [], []]);
  assert.equal((await h.call(CHANNELS.masteryCourse, 'nope')).error.code, 'unknown_course');
});
