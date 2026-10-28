import { test } from 'vitest';
import assert from 'node:assert/strict';

import * as progress from '../../../src/main/courses/lab_progress.ts';
import { businessDay } from '../../../src/main/activity/activity_log.ts';
import type { MasteryAttempt, MasteryRecord } from '../../../src/main/courses/mastery_store.ts';
import type { Concept } from '../../../src/shared/course_pack.ts';
import type { PathEntry } from '../../../src/shared/course_plan.ts';
import type { Difficulty } from '../../../src/shared/ipc/packages.ts';

let clock = 0;
const attempt = (result: MasteryAttempt['result'], overrides: Partial<MasteryAttempt> = {}): MasteryAttempt => ({
  at: new Date(Date.UTC(2026, 9, 27) + (clock += 60_000)).toISOString(),
  packageId: 'lab-x',
  repoId: 'repo1',
  result,
  independence: null,
  errorTypes: [],
  difficulty: 'easy',
  hintLevel: null,
  ...overrides,
});

const record = (conceptId: string, attempts: MasteryAttempt[]): MasteryRecord => ({
  course: 'os',
  conceptId,
  attempts,
  totals: {
    attempts: attempts.length,
    pass: attempts.filter((entry) => entry.result === 'pass').length,
    partial: attempts.filter((entry) => entry.result === 'partial').length,
    fail: attempts.filter((entry) => entry.result === 'fail').length,
  },
  errorCounts: [],
});

const records = (...items: MasteryRecord[]) => new Map(items.map((item) => [item.conceptId, item]));

const concept = (id: string, prerequisites: string[] = []): Concept => ({ id, label: id, summary: id, prerequisites });

// The CARM-33 example's path: process-state known, fcfs and round-robin
// covered by lab 01, priority-sched and aging after it.
const CONCEPTS = [
  concept('process-state'),
  concept('fcfs', ['process-state']),
  concept('round-robin', ['fcfs']),
  concept('priority-sched', ['round-robin']),
  concept('aging', ['priority-sched']),
];
const PATH: PathEntry[] = [
  { conceptId: 'process-state', status: 'known' },
  { conceptId: 'fcfs', status: 'planned' },
  { conceptId: 'round-robin', status: 'planned' },
  { conceptId: 'priority-sched', status: 'planned' },
  { conceptId: 'aging', status: 'planned' },
];
const next = (items: Map<string, MasteryRecord>, start: Difficulty = 'easy', path = PATH) =>
  progress.nextConcept({ path, concepts: CONCEPTS, records: items, start });

test('mastered: the last two attempts passed with independence of at least 70', () => {
  assert.equal(progress.isMastered(null), false);
  assert.equal(progress.isMastered(record('x', [attempt('pass', { independence: 95 })])), false);
  assert.equal(progress.isMastered(record('x', [attempt('pass', { independence: 70 }), attempt('pass', { independence: 70 })])), true);
  assert.equal(progress.isMastered(record('x', [attempt('pass', { independence: 69 }), attempt('pass', { independence: 90 })])), false);
  assert.equal(progress.isMastered(record('x', [attempt('pass'), attempt('partial')])), false);
  // An older fail does not count; only the last two do.
  assert.equal(progress.isMastered(record('x', [attempt('fail'), attempt('pass'), attempt('pass')])), true);
  // Independence is null until T10; it does not hold mastery back.
  assert.equal(progress.isMastered(record('x', [attempt('pass'), attempt('pass')])), true);
});

test('difficulty: two fails lower it, a pass with hints up to L2 raises it, anything else keeps it', () => {
  assert.deepEqual(progress.nextDifficulty([attempt('fail', { difficulty: 'medium' }), attempt('fail', { difficulty: 'medium' })], 'easy'), {
    level: 'easy',
    change: 'lowered',
  });
  assert.deepEqual(progress.nextDifficulty([attempt('pass', { difficulty: 'easy', hintLevel: 2 })], 'easy'), { level: 'medium', change: 'raised' });
  assert.deepEqual(progress.nextDifficulty([attempt('pass', { difficulty: 'easy', hintLevel: null })], 'easy'), { level: 'medium', change: 'raised' });
  // L3 opened: the pass keeps the difficulty.
  assert.deepEqual(progress.nextDifficulty([attempt('pass', { difficulty: 'easy', hintLevel: 3 })], 'easy'), { level: 'easy', change: 'kept' });
  // One fail, or a fail after a partial, keeps it.
  assert.deepEqual(progress.nextDifficulty([attempt('fail', { difficulty: 'medium' })], 'easy'), { level: 'medium', change: 'kept' });
  assert.deepEqual(progress.nextDifficulty([attempt('partial', { difficulty: 'medium' }), attempt('fail', { difficulty: 'medium' })], 'easy'), {
    level: 'medium',
    change: 'kept',
  });
  // Bounds: hard cannot go up, easy cannot go down.
  assert.deepEqual(progress.nextDifficulty([attempt('pass', { difficulty: 'hard' })], 'easy'), { level: 'hard', change: 'kept' });
  assert.deepEqual(progress.nextDifficulty([attempt('fail'), attempt('fail')], 'medium'), { level: 'easy', change: 'kept' });
  // No attempt, or an attempt from before difficulty was recorded: `start`.
  assert.deepEqual(progress.nextDifficulty([], 'medium'), { level: 'medium', change: 'kept' });
  assert.deepEqual(progress.nextDifficulty([attempt('fail', { difficulty: undefined })], 'medium'), { level: 'medium', change: 'kept' });
});

test('not stuck: a prerequisite failing twice is lowered each time until easy, then the learner is told to review or skip it', () => {
  const hard = [attempt('fail', { difficulty: 'hard' }), attempt('fail', { difficulty: 'hard' })];
  let picked = next(records(record('fcfs', hard)), 'hard');
  assert.deepEqual(picked, { conceptId: 'fcfs', difficulty: 'medium', change: 'lowered', stuck: false });
  const medium = [...hard, attempt('fail', { difficulty: 'medium' }), attempt('fail', { difficulty: 'medium' })];
  picked = next(records(record('fcfs', medium)), 'hard');
  assert.deepEqual(picked, { conceptId: 'fcfs', difficulty: 'easy', change: 'lowered', stuck: false });
  const easy = [...medium, attempt('fail', { difficulty: 'easy' }), attempt('fail', { difficulty: 'easy' })];
  picked = next(records(record('fcfs', easy)), 'hard');
  assert.deepEqual(picked, { conceptId: 'fcfs', difficulty: 'easy', change: 'kept', stuck: true });
  // Its dependants wait meanwhile; skipping it lets them through.
  const skipped = PATH.map((entry) => (entry.conceptId === 'fcfs' ? { ...entry, status: 'skipped' as const } : entry));
  assert.equal(next(records(record('fcfs', easy)), 'hard', skipped)?.conceptId, 'round-robin');
  // A pass at easy after that is no longer stuck.
  assert.equal(next(records(record('fcfs', [...easy, attempt('pass', { hintLevel: 4 })])), 'hard')?.stuck, false);
});

test('selection: the first concept on the path whose prerequisites passed and which is not mastered', () => {
  assert.deepEqual(next(records()), { conceptId: 'fcfs', difficulty: 'easy', change: 'kept', stuck: false });
  // A concept that failed last time comes before one that passed.
  const passedFcfs = record('fcfs', [attempt('pass', { hintLevel: 3 })]);
  const failedRr = record('round-robin', [attempt('fail')]);
  assert.equal(next(records(passedFcfs, failedRr))?.conceptId, 'round-robin');
  // Without a pass of round-robin, priority-sched waits.
  assert.equal(next(records(passedFcfs))?.conceptId, 'round-robin');
  // Known and skipped concepts and prerequisites off the path count as passed.
  const offPath = PATH.filter((entry) => entry.conceptId !== 'fcfs');
  assert.equal(next(records(), 'easy', offPath)?.conceptId, 'round-robin');
  // Mastered concepts are done; nothing left to learn is null.
  const twice = (id: string) => record(id, [attempt('pass'), attempt('pass')]);
  assert.equal(next(records(twice('fcfs'), twice('round-robin'), twice('priority-sched')))?.conceptId, 'aging');
  assert.equal(next(records(twice('fcfs'), twice('round-robin'), twice('priority-sched'), twice('aging'))), null);
  // When every open concept passed last time, the first comes back to make it stick.
  const short = PATH.slice(0, 3);
  assert.equal(next(records(passedFcfs, record('round-robin', [attempt('pass', { hintLevel: 3 })])), 'easy', short)?.conceptId, 'fcfs');
});

test('selection: a concept the learner picked must be planned and not mastered', () => {
  const pick = (only: string, items = records()) => progress.nextConcept({ path: PATH, concepts: CONCEPTS, records: items, start: 'easy', only });
  // Prerequisites aside: the learner chose it after a self-check failed.
  assert.equal(pick('aging')?.conceptId, 'aging');
  assert.equal(pick('process-state'), null);
  assert.equal(pick('fcfs', records(record('fcfs', [attempt('pass'), attempt('pass')]))), null);
});

test('the CARM-33 example: after round-robin first passes with L1 and L3, priority-sched comes next at the same difficulty', () => {
  // Lab 01 covered fcfs and round-robin; the student used L1 and L3 and passed at last.
  const lab01 = (result: MasteryAttempt['result']) => attempt(result, { packageId: 'lab-round-robin', difficulty: 'easy', hintLevel: 3 });
  const done = records(record('fcfs', [lab01('fail'), lab01('pass')]), record('round-robin', [lab01('fail'), lab01('pass')]));
  // One pass is not mastery, but both passed last time, so priority-sched
  // (its prerequisite passed, never tried) goes first; L3 keeps the difficulty.
  assert.equal(progress.isMastered(done.get('round-robin')!), false);
  assert.deepEqual(next(done), { conceptId: 'priority-sched', difficulty: 'easy', change: 'kept', stuck: false });
  // Hints only up to L2 would have raised it.
  const easy = records(record('fcfs', [attempt('pass', { hintLevel: 2 })]), record('round-robin', [attempt('pass', { hintLevel: 2 })]));
  assert.deepEqual(next(easy), { conceptId: 'priority-sched', difficulty: 'medium', change: 'raised', stuck: false });
});

test('Leitner: remembered moves up a box (1/3/7/14/30 days), forgotten goes back to box 1', () => {
  let schedule = progress.firstSchedule('RR 入队顺序.md', '2026-10-27');
  assert.deepEqual(schedule, { noteId: 'RR 入队顺序.md', box: 1, dueDay: '2026-10-28' });
  const days: string[] = [];
  for (const day of ['2026-10-28', '2026-10-31', '2026-11-07', '2026-11-21', '2026-12-21']) {
    assert.equal(progress.isDue(schedule, day), true);
    schedule = progress.reviewed(schedule, true, day);
    days.push(`${schedule.box}:${schedule.dueDay}`);
  }
  assert.deepEqual(days, ['2:2026-10-31', '3:2026-11-07', '4:2026-11-21', '5:2026-12-21', '5:2027-01-20']);
  schedule = progress.reviewed(schedule, false, '2027-01-20');
  assert.deepEqual(schedule, { noteId: 'RR 入队顺序.md', box: 1, dueDay: '2027-01-21' });
  assert.equal(progress.isDue(schedule, '2027-01-20'), false);
  // Overdue stays due.
  assert.equal(progress.isDue(schedule, '2027-02-01'), true);
});

test('business day: a note written at 23:30 UTC is a Shanghai day later, and due by Shanghai midnight, not UTC midnight', () => {
  const zone = 'Asia/Shanghai';
  // 2026-10-27 23:30 UTC is 2026-10-28 07:30 in Shanghai.
  const note = { id: 'n.md', concepts: ['round-robin'], createdAt: '2026-10-27T23:30:00.000Z' };
  const [schedule] = progress.schedulesOf([note, { id: 'plain.md', concepts: [], createdAt: note.createdAt }], new Map(), zone);
  assert.deepEqual(schedule, { noteId: 'n.md', box: 1, dueDay: '2026-10-29' });
  // 2026-10-28 16:30 UTC is already 2026-10-29 00:30 in Shanghai: due.
  assert.equal(progress.isDue(schedule, businessDay(new Date('2026-10-28T16:30:00.000Z'), zone)), true);
  // 2026-10-28 15:59 UTC is 23:59 on the 28th in Shanghai: not yet, though UTC says the 28th too.
  assert.equal(progress.isDue(schedule, businessDay(new Date('2026-10-28T15:59:00.000Z'), zone)), false);
  // The same instant in another business zone is another day.
  assert.deepEqual(progress.schedulesOf([note], new Map(), 'America/Los_Angeles')[0].dueDay, '2026-10-28');
  // A saved schedule wins over the first one.
  const saved = new Map([['n.md', { noteId: 'n.md', box: 3, dueDay: '2026-11-07' }]]);
  assert.deepEqual(progress.schedulesOf([note], saved, zone), [{ noteId: 'n.md', box: 3, dueDay: '2026-11-07' }]);
});

test('addDays steps calendar days across month, year and DST changes', () => {
  assert.equal(progress.addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(progress.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(progress.addDays('2027-03-13', 1), '2027-03-14');
  assert.equal(progress.addDays('2028-02-28', 1), '2028-02-29');
});
