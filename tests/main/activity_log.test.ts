import { onTestFinished, test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ActivityLog, EVENTS_DIRNAME, RETENTION_DAYS, businessDay, computeMetrics, recentDays } from '../../src/main/activity_log.ts';
import type { ActivityRecord } from '../../src/shared/ipc_types.ts';

const SHANGHAI = 'Asia/Shanghai';

const tempDir = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'taskpilot-activity-'));
  onTestFinished(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
};

const transition = (packageId: string, name: string, to: string, at: string): ActivityRecord => ({
  kind: 'package_transition', packageId, title: packageId, transition: name as never, actor: 'human', from: 'pending', to: to as never, at,
});

test('businessDay() buckets by the business time zone, not UTC', () => {
  // 2026-10-05 17:30 UTC is already 10-06 in Shanghai.
  assert.equal(businessDay(new Date('2026-10-05T17:30:00Z'), SHANGHAI), '2026-10-06');
  assert.equal(businessDay(new Date('2026-10-05T17:30:00Z'), 'UTC'), '2026-10-05');
});

test('recentDays() lists distinct calendar days newest first, across DST', () => {
  const days = recentDays(new Date('2026-11-02T12:00:00Z'), 'America/New_York', 4);
  assert.deepEqual(days, ['2026-11-02', '2026-11-01', '2026-10-31', '2026-10-30']);
});

test('append() writes one line per event into the business day file', async () => {
  const dir = await tempDir();
  const log = new ActivityLog(dir, { timeZone: SHANGHAI, now: () => new Date('2026-10-05T17:30:00Z') });
  await Promise.all([
    log.append({ kind: 'requirement_created', requirementId: 'r1', title: 'A' }),
    log.append({ kind: 'requirement_created', requirementId: 'r2', title: 'B' }),
  ]);
  const text = await fs.readFile(path.join(dir, EVENTS_DIRNAME, '2026-10-06.jsonl'), 'utf8');
  const lines = text.trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((line) => line.requirementId), ['r1', 'r2']);
  assert.equal(lines[0].at, '2026-10-05T17:30:00.000Z');
});

test('recent() returns newest first, capped, and skips a torn last line', async () => {
  const dir = await tempDir();
  let now = new Date('2026-10-04T02:00:00Z');
  const log = new ActivityLog(dir, { timeZone: SHANGHAI, now: () => now });
  await log.append({ kind: 'requirement_created', requirementId: 'old', title: 'old' });
  now = new Date('2026-10-06T02:00:00Z');
  await log.append({ kind: 'requirement_created', requirementId: 'a', title: 'a' });
  await log.append({ kind: 'requirement_created', requirementId: 'b', title: 'b' });
  await fs.appendFile(path.join(dir, EVENTS_DIRNAME, '2026-10-06.jsonl'), '{"kind":"requirement_cr');
  const recent = await log.recent({ days: 7, limit: 2 });
  assert.deepEqual(recent.map((record) => record.kind === 'requirement_created' && record.requirementId), ['b', 'a']);
  const all = await log.recent({ days: 7, limit: 10 });
  assert.equal(all.length, 3);
});

test('prune() deletes day files past the retention window and keeps the rest', async () => {
  const dir = await tempDir();
  const events = path.join(dir, EVENTS_DIRNAME);
  await fs.mkdir(events);
  const now = new Date('2026-10-06T02:00:00Z');
  const kept = recentDays(now, SHANGHAI, RETENTION_DAYS);
  await fs.writeFile(path.join(events, `${kept.at(-1)}.jsonl`), '');
  await fs.writeFile(path.join(events, '2026-09-01.jsonl'), '');
  await fs.writeFile(path.join(events, 'notes.txt'), '');
  const removed = await new ActivityLog(dir, { timeZone: SHANGHAI, now: () => now }).prune();
  assert.deepEqual(removed, ['2026-09-01.jsonl']);
  assert.deepEqual((await fs.readdir(events)).sort(), [`${kept.at(-1)}.jsonl`, 'notes.txt']);
});

test('prune() is a no-op before anything was recorded', async () => {
  assert.deepEqual(await new ActivityLog(await tempDir(), { timeZone: SHANGHAI }).prune(), []);
});

test('computeMetrics() counts done packages per week and averages claim-to-done hours', () => {
  const now = new Date('2026-10-06T04:00:00Z');
  const records = [
    transition('p1', 'claim', 'in_progress', '2026-09-20T00:00:00Z'),
    transition('p1', 'accepted', 'done', '2026-09-28T00:00:00Z'), // previous week
    transition('p2', 'claim', 'in_progress', '2026-10-05T00:00:00Z'),
    transition('p2', 'review_accepted', 'done', '2026-10-05T02:00:00Z'), // 2h
    transition('p3', 'claim', 'in_progress', '2026-10-01T00:00:00Z'),
    transition('p3', 'release', 'pending', '2026-10-01T01:00:00Z'),
    transition('p3', 'claim', 'in_progress', '2026-10-06T00:00:00Z'),
    transition('p3', 'accepted', 'done', '2026-10-06T04:00:00Z'), // 4h, counted from the second claim
    transition('p4', 'accepted', 'done', '2026-10-06T03:00:00Z'), // claim older than the window
  ];
  const metrics = computeMetrics(records, now, SHANGHAI);
  assert.equal(metrics.doneThisWeek, 3);
  assert.equal(metrics.donePreviousWeek, 1);
  assert.equal(metrics.averageHours, 3);
  assert.equal(metrics.averageHoursPrevious, 192);
});

test('computeMetrics() reports no average without finished work', () => {
  assert.deepEqual(computeMetrics([], new Date(), SHANGHAI), { doneThisWeek: 0, donePreviousWeek: 0, averageHours: null, averageHoursPrevious: null });
});

test('page() walks whole days newest first and continues from nextBefore', async () => {
  const dir = await tempDir();
  let now = new Date('2026-10-01T02:00:00Z');
  const log = new ActivityLog(dir, { timeZone: SHANGHAI, now: () => now });
  for (const [day, count] of [['2026-10-01', 2], ['2026-10-03', 1], ['2026-10-05', 3]] as const) {
    now = new Date(`${day}T02:00:00Z`);
    for (let i = 0; i < count; i += 1) await log.append({ kind: 'requirement_created', requirementId: `${day}-${i}`, title: 't' });
  }
  now = new Date('2026-10-06T02:00:00Z');
  const first = await log.page({ before: null, minEvents: 3 });
  assert.deepEqual(first.days.map((entry) => [entry.day, entry.records.length]), [['2026-10-05', 3]]);
  assert.equal(first.days[0].records[0].kind === 'requirement_created' && first.days[0].records[0].requirementId, '2026-10-05-2');
  const second = await log.page({ before: first.nextBefore, minEvents: 3 });
  assert.deepEqual(second.days.map((entry) => entry.day), ['2026-10-03', '2026-10-01']);
  const last = await log.page({ before: second.nextBefore, minEvents: 3 });
  assert.deepEqual(last.days, []);
  assert.equal(last.nextBefore, null);
});
