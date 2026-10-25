import { onTestFinished, test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ActivityLog, EVENTS_DIRNAME, RETENTION_DAYS, businessDay, recentDays } from '../../src/main/activity_log.ts';
import { ROLLUP_FILENAME } from '../../src/main/cost_rollup.ts';

const SHANGHAI = 'Asia/Shanghai';

const tempDir = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'taskpilot-activity-'));
  onTestFinished(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
};

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
  const lines = text
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    lines.map((line) => line.requirementId),
    ['r1', 'r2'],
  );
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
  assert.deepEqual(
    recent.map((record) => record.kind === 'requirement_created' && record.requirementId),
    ['b', 'a'],
  );
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
  assert.deepEqual((await fs.readdir(events)).sort(), [`${kept.at(-1)}.jsonl`, ROLLUP_FILENAME, 'notes.txt']);
});

test('prune() folds expired costs into the rollup once, even when run again', async () => {
  const dir = await tempDir();
  const events = path.join(dir, EVENTS_DIRNAME);
  await fs.mkdir(events);
  const now = new Date('2026-10-13T02:00:00Z');
  const tokens = { input: 100, output: 10, cacheRead: 5, cacheWrite: 0 };
  const lines = [
    { kind: 'agent_cost', agent: 'qa', costUsd: 0.2, at: '2026-09-01T03:00:00Z' },
    {
      kind: 'agent_cost',
      agent: 'qa',
      costUsd: null,
      call: { cli: 'pi', provider: 'deepseek', model: 'deepseek-v4', costUsd: null, tokens },
      at: '2026-09-01T04:00:00Z',
    },
    {
      kind: 'agent_cost',
      agent: 'tutor',
      costUsd: null,
      call: { cli: 'grok', provider: 'xai', model: null, costUsd: null, tokens: null },
      at: '2026-09-01T05:00:00Z',
    },
  ];
  await fs.writeFile(path.join(events, '2026-09-01.jsonl'), lines.map((line) => JSON.stringify(line)).join('\n'));
  const log = new ActivityLog(dir, { timeZone: SHANGHAI, now: () => now });
  await log.prune();
  // A prune that stopped before deleting folds the same day again.
  await fs.writeFile(path.join(events, '2026-09-01.jsonl'), lines.map((line) => JSON.stringify(line)).join('\n'));
  await log.prune();
  const rows = await log.rollup();
  assert.equal(rows.length, 3);
  const legacy = rows.find((row) => row.cli === null);
  assert.deepEqual([legacy?.actualCalls, legacy?.actualMicros], [1, 200_000]);
  const estimated = rows.find((row) => row.cli === 'pi');
  assert.deepEqual([estimated?.tokenCalls, estimated?.tokens], [1, tokens]);
  assert.equal(rows.find((row) => row.agent === 'tutor')?.unknownCalls, 1);
  assert.deepEqual(await fs.readdir(events), [ROLLUP_FILENAME]);
});

test('prune() drops rollup rows older than a year', async () => {
  const dir = await tempDir();
  const events = path.join(dir, EVENTS_DIRNAME);
  await fs.mkdir(events);
  const row = (day: string) => ({
    day,
    agent: 'qa',
    cli: null,
    provider: null,
    model: null,
    actualCalls: 1,
    actualMicros: 1_000_000,
    tokenCalls: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    unknownCalls: 0,
  });
  await fs.writeFile(path.join(events, ROLLUP_FILENAME), JSON.stringify({ version: 1, rows: [row('2025-09-01'), row('2026-01-01')] }));
  await fs.writeFile(path.join(events, '2026-09-01.jsonl'), '');
  const log = new ActivityLog(dir, { timeZone: SHANGHAI, now: () => new Date('2026-10-13T02:00:00Z') });
  await log.prune();
  assert.deepEqual(
    (await log.rollup()).map((kept) => kept.day),
    ['2026-01-01'],
  );
});

test('prune() writes the rollup through a temp file and keeps the day files when that fails', async () => {
  const dir = await tempDir();
  const events = path.join(dir, EVENTS_DIRNAME);
  await fs.mkdir(events);
  const previous = JSON.stringify({ version: 1, rows: [] });
  await fs.writeFile(path.join(events, ROLLUP_FILENAME), previous);
  await fs.writeFile(path.join(events, '2026-09-01.jsonl'), JSON.stringify({ kind: 'agent_cost', agent: 'qa', costUsd: 0.2, at: '2026-09-01T03:00:00Z' }));
  // A directory where the temp file goes makes the rollup write fail.
  await fs.mkdir(path.join(events, `${ROLLUP_FILENAME}.tmp`));
  const log = new ActivityLog(dir, { timeZone: SHANGHAI, now: () => new Date('2026-10-13T02:00:00Z') });
  await assert.rejects(() => log.prune());
  assert.equal(await fs.readFile(path.join(events, ROLLUP_FILENAME), 'utf8'), previous);
  assert.equal((await fs.readdir(events)).includes('2026-09-01.jsonl'), true);
});

test('prune() is a no-op before anything was recorded', async () => {
  assert.deepEqual(await new ActivityLog(await tempDir(), { timeZone: SHANGHAI }).prune(), []);
});

test('page() walks whole days newest first and continues from nextBefore', async () => {
  const dir = await tempDir();
  let now = new Date('2026-10-01T02:00:00Z');
  const log = new ActivityLog(dir, { timeZone: SHANGHAI, now: () => now });
  for (const [day, count] of [
    ['2026-10-01', 2],
    ['2026-10-03', 1],
    ['2026-10-05', 3],
  ] as const) {
    now = new Date(`${day}T02:00:00Z`);
    for (let i = 0; i < count; i += 1) await log.append({ kind: 'requirement_created', requirementId: `${day}-${i}`, title: 't' });
  }
  now = new Date('2026-10-06T02:00:00Z');
  const first = await log.page({ before: null, minEvents: 3 });
  assert.deepEqual(
    first.days.map((entry) => [entry.day, entry.records.length]),
    [['2026-10-05', 3]],
  );
  assert.equal(first.days[0].records[0].kind === 'requirement_created' && first.days[0].records[0].requirementId, '2026-10-05-2');
  const second = await log.page({ before: first.nextBefore, minEvents: 3 });
  assert.deepEqual(
    second.days.map((entry) => entry.day),
    ['2026-10-03', '2026-10-01'],
  );
  const last = await log.page({ before: second.nextBefore, minEvents: 3 });
  assert.deepEqual(last.days, []);
  assert.equal(last.nextBefore, null);
});

test('agent spend is stored with the events but kept out of the feed', async () => {
  const dir = await tempDir();
  const now = new Date('2026-10-07T02:00:00Z');
  const log = new ActivityLog(dir, { timeZone: SHANGHAI, now: () => now });
  await log.append({ kind: 'requirement_created', requirementId: 'a', title: 'a' });
  await log.append({ kind: 'agent_cost', agent: 'qa', costUsd: 0.2 });
  assert.deepEqual(
    (await log.recent({ days: 7, limit: 10 })).map((record) => record.kind),
    ['requirement_created'],
  );
  const page = await log.page({ before: null, minEvents: 10 });
  assert.deepEqual(
    page.days.flatMap((day) => day.records.map((record) => record.kind)),
    ['requirement_created'],
  );
  assert.deepEqual(
    (await log.window(7)).map((record) => record.kind),
    ['requirement_created', 'agent_cost'],
  );
});
