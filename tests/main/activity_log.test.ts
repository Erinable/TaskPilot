import { onTestFinished, test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  ActivityLog,
  EVENTS_DIRNAME,
  RETENTION_DAYS,
  agentOf,
  businessDay,
  computeAgentCosts,
  computeMetrics,
  recentByAgent,
  recentDays,
} from '../../src/main/activity_log.ts';
import { ROLLUP_FILENAME } from '../../src/main/cost_rollup.ts';
import type { LoggedRecord } from '../../src/main/activity_log.ts';
import type { ActivityRecord } from '../../src/shared/ipc_types.ts';

const SHANGHAI = 'Asia/Shanghai';

const tempDir = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'taskpilot-activity-'));
  onTestFinished(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
};

const transition = (packageId: string, name: string, to: string, at: string): ActivityRecord => ({
  kind: 'package_transition',
  packageId,
  title: packageId,
  transition: name as never,
  actor: 'human',
  from: 'pending',
  to: to as never,
  at,
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

const cost = (agent: string, costUsd: number, at: string): LoggedRecord => ({ kind: 'agent_cost', agent: agent as never, costUsd, at });

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

test('computeAgentCosts() sums the metrics week per agent and flags a partly recorded week', () => {
  const now = new Date('2026-10-07T04:00:00Z');
  const records = [
    cost('qa', 0.1, '2026-10-07T01:00:00Z'),
    cost('qa', 0.25, '2026-10-06T01:00:00Z'),
    cost('architect', 0.5, '2026-10-05T01:00:00Z'),
    cost('nobody', 9, '2026-10-05T01:00:00Z'), // unknown agent
    cost('qa', Number.NaN, '2026-10-05T01:00:00Z'), // bad amount
  ];
  const costs = computeAgentCosts(records, now, SHANGHAI);
  assert.deepEqual(costs.byAgent, { 'product-lead': 0, architect: 0.5, qa: 0.35, 'release-manager': 0, 'coding-agent': 0 });
  assert.equal(costs.since, '2026-10-05T01:00:00Z');
  assert.equal(costs.partial, true);
});

test('computeAgentCosts() counts only the week once spend has a full week of history', () => {
  const now = new Date('2026-10-20T04:00:00Z');
  const costs = computeAgentCosts([cost('release-manager', 1, '2026-10-01T01:00:00Z'), cost('release-manager', 0.4, '2026-10-19T01:00:00Z')], now, SHANGHAI);
  assert.equal(costs.byAgent['release-manager'], 0.4);
  assert.equal(costs.partial, false);
});

test('computeAgentCosts() with no spend yet is empty and partial', () => {
  const costs = computeAgentCosts([], new Date(), SHANGHAI);
  assert.deepEqual(costs, { byAgent: { 'product-lead': 0, architect: 0, qa: 0, 'release-manager': 0, 'coding-agent': 0 }, since: null, partial: true });
});

test("recentByAgent() takes each member's newest events from the whole window", () => {
  const review = (packageId: string, at: string) => transition(packageId, 'review_passed', 'accepting', at);
  const records: LoggedRecord[] = [
    review('p1', '2026-09-20T00:00:00Z'),
    { kind: 'release_finished', version: '1.0.0', packageCount: 1, at: '2026-09-21T00:00:00Z' },
    review('p2', '2026-10-01T00:00:00Z'),
    review('p3', '2026-10-02T00:00:00Z'),
    cost('qa', 0.1, '2026-10-02T00:00:01Z'),
    review('p4', '2026-10-03T00:00:00Z'),
    // Many human steps after them, as in a real queue.
    ...Array.from({ length: 30 }, (_unused, index) => transition(`h${index}`, 'claim', 'in_progress', `2026-10-06T00:${String(index).padStart(2, '0')}:00Z`)),
  ];
  const recent = recentByAgent(records, 3);
  assert.deepEqual(
    recent.qa.map((record) => record.kind === 'package_transition' && record.packageId),
    ['p4', 'p3', 'p2'],
  );
  assert.deepEqual(
    recent['release-manager'].map((record) => record.kind),
    ['release_finished'],
  );
  assert.deepEqual(recent.architect, []);
  assert.deepEqual(recent['product-lead'], []);
});

test('agentOf() ignores human transitions and unknown names', () => {
  assert.equal(agentOf(transition('p', 'claim', 'in_progress', '2026-10-01T00:00:00Z')), null);
  assert.equal(agentOf(transition('p', 'toString', 'in_progress', '2026-10-01T00:00:00Z')), null);
  assert.equal(agentOf(transition('p', 'replanned', 'pending', '2026-10-01T00:00:00Z')), 'architect');
});
