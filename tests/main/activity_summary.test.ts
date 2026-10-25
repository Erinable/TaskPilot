import { onTestFinished, test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ActivityLog, RETENTION_DAYS, businessDay, recentDays } from '../../src/main/activity_log.ts';
import { ActivitySummary, agentOf } from '../../src/main/activity_summary.ts';
import type { LoggedEvent, LoggedRecord } from '../../src/main/activity_log.ts';
import type { EstimateRow } from '../../src/main/activity_summary.ts';
import type { ActivityRecord } from '../../src/shared/ipc_types.ts';

const SHANGHAI = 'Asia/Shanghai';

const tempDir = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'taskpilot-summary-'));
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

const cost = (agent: string, costUsd: number, at: string): LoggedRecord => ({ kind: 'agent_cost', agent: agent as never, costUsd, at });

// A summary of `records` as the overview would read it at `now`.
const summarize = (records: LoggedRecord[], now: Date, estimate?: EstimateRow) => {
  const summary = new ActivitySummary((at) => businessDay(new Date(at), SHANGHAI));
  for (const record of records) summary.add(record);
  return summary.read(recentDays(now, SHANGHAI, RETENTION_DAYS), estimate);
};

test('metrics count done packages per week and average claim-to-done hours', () => {
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
  const { metrics } = summarize(records, new Date('2026-10-06T04:00:00Z'));
  assert.equal(metrics.doneThisWeek, 3);
  assert.equal(metrics.donePreviousWeek, 1);
  assert.equal(metrics.averageHours, 3);
  assert.equal(metrics.averageHoursPrevious, 192);
});

test('metrics report no average without finished work', () => {
  assert.deepEqual(summarize([], new Date()).metrics, { doneThisWeek: 0, donePreviousWeek: 0, averageHours: null, averageHoursPrevious: null });
});

test('a claim that has left the window no longer gives an average', () => {
  const records = [transition('p1', 'claim', 'in_progress', '2026-09-01T00:00:00Z'), transition('p1', 'accepted', 'done', '2026-09-25T00:00:00Z')];
  assert.equal(summarize(records, new Date('2026-09-26T04:00:00Z')).metrics.averageHours, 576);
  // 30 days on, the claim's day is gone; the done day is still the previous week.
  assert.equal(summarize(records, new Date('2026-10-03T04:00:00Z')).metrics.averageHoursPrevious, null);
});

test('spend sums the metrics week per agent and flags a partly recorded week', () => {
  const records = [
    cost('qa', 0.1, '2026-10-07T01:00:00Z'),
    cost('qa', 0.25, '2026-10-06T01:00:00Z'),
    cost('architect', 0.5, '2026-10-05T01:00:00Z'),
    cost('nobody', 9, '2026-10-05T01:00:00Z'), // unknown agent
    cost('qa', Number.NaN, '2026-10-05T01:00:00Z'), // bad amount
  ];
  const { costs } = summarize(records, new Date('2026-10-07T04:00:00Z'));
  assert.deepEqual(costs.byAgent, { 'product-lead': 0, architect: 0.5, qa: 0.35, 'release-manager': 0, 'coding-agent': 0 });
  assert.equal(costs.since, '2026-10-05T01:00:00Z');
  assert.equal(costs.partial, true);
});

test('spend counts only the week once it has a full week of history', () => {
  const { costs } = summarize(
    [cost('release-manager', 1, '2026-10-01T01:00:00Z'), cost('release-manager', 0.4, '2026-10-19T01:00:00Z')],
    new Date('2026-10-20T04:00:00Z'),
  );
  assert.equal(costs.byAgent['release-manager'], 0.4);
  assert.equal(costs.partial, false);
});

test('spend with nothing recorded yet is empty and partial', () => {
  assert.deepEqual(summarize([], new Date()).costs, {
    byAgent: { 'product-lead': 0, architect: 0, qa: 0, 'release-manager': 0, 'coding-agent': 0 },
    since: null,
    partial: true,
  });
});

test('token-only spend is priced per model with the estimate given at read time', () => {
  const tokenCall = (input: number, at: string): LoggedRecord => ({
    kind: 'agent_cost',
    agent: 'qa',
    costUsd: null,
    call: { cli: 'pi', provider: 'deepseek', model: 'v4', costUsd: null, tokens: { input, output: 0, cacheRead: 0, cacheWrite: 0 } },
    at,
  });
  const records = [tokenCall(100, '2026-10-06T01:00:00Z'), tokenCall(300, '2026-10-07T01:00:00Z')];
  const now = new Date('2026-10-07T04:00:00Z');
  const unpriced = summarize(records, now);
  assert.equal(unpriced.costs.byAgent.qa, 0);
  assert.equal(unpriced.costs.since, null);
  const priced = summarize(records, now, (row) => row.tokens.input * 10);
  assert.equal(priced.costs.byAgent.qa, 0.004);
  assert.equal(priced.costs.since, '2026-10-06T01:00:00Z');
});

test("each member's newest events come from the whole window", () => {
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
  const { teamRecent, recent } = summarize(records, new Date('2026-10-06T04:00:00Z'));
  assert.deepEqual(
    teamRecent.qa.map((record) => record.kind === 'package_transition' && record.packageId),
    ['p4', 'p3', 'p2'],
  );
  assert.deepEqual(
    teamRecent['release-manager'].map((record) => record.kind),
    ['release_finished'],
  );
  assert.deepEqual(teamRecent.architect, []);
  assert.deepEqual(teamRecent['product-lead'], []);
  assert.equal(recent.length, 20);
  assert.equal(recent[0].kind === 'package_transition' && recent[0].packageId, 'h29');
});

test('agentOf() ignores human transitions and unknown names', () => {
  assert.equal(agentOf(transition('p', 'claim', 'in_progress', '2026-10-01T00:00:00Z')), null);
  assert.equal(agentOf(transition('p', 'toString', 'in_progress', '2026-10-01T00:00:00Z')), null);
  assert.equal(agentOf(transition('p', 'replanned', 'pending', '2026-10-01T00:00:00Z')), 'architect');
});

// ========== incremental vs a fresh read of the files ==========

// One event per kind that matters, spread over `days` business days.
const eventsFor = (day: number): LoggedEvent[] => [
  { kind: 'package_transition', packageId: `p${day}`, title: 'p', transition: 'claim', actor: 'human', from: 'pending', to: 'in_progress' },
  { kind: 'agent_cost', agent: 'qa', costUsd: 0.01 * (day + 1) },
  { kind: 'package_transition', packageId: `p${day}`, title: 'p', transition: 'review_passed', actor: 'agent', from: 'in_review', to: 'accepting' },
  {
    kind: 'agent_cost',
    agent: 'architect',
    costUsd: null,
    call: { cli: 'pi', provider: 'x', model: 'm', costUsd: null, tokens: { input: 50, output: 5, cacheRead: 0, cacheWrite: 0 } },
  },
  { kind: 'package_transition', packageId: `p${day}`, title: 'p', transition: 'accepted', actor: 'human', from: 'accepting', to: 'done' },
];

const estimate: EstimateRow = (row) => row.tokens.input * 3 + row.tokens.output * 7;

// What a log opened on `dir` fresh at `now` reports, built only from the files.
const fromFiles = (dir: string, now: Date) => new ActivityLog(dir, { timeZone: SHANGHAI, now: () => now }).overview(estimate);

test('an overview kept current by appends matches a fresh read, across days and after a prune', async () => {
  const dir = await tempDir();
  let now = new Date('2026-09-01T02:00:00Z');
  const log = new ActivityLog(dir, { timeZone: SHANGHAI, now: () => now });
  // Built before anything is recorded, so everything after arrives as appends.
  await log.overview(estimate);
  for (let day = 0; day < 45; day += 1) {
    // 15:30 UTC is 23:30 in Shanghai; 16:30 is already the next business day.
    for (const [index, event] of eventsFor(day).entries()) {
      now = new Date(Date.parse('2026-09-01T15:30:00Z') + day * 86_400_000 + index * 20 * 60_000);
      await log.append(event);
    }
    if (day % 9 === 0) assert.deepEqual(await log.overview(estimate), await fromFiles(dir, now), `day ${day}`);
  }
  // A week with nothing new: events age out of the metrics weeks and the window.
  now = new Date(now.getTime() + 7 * 86_400_000);
  assert.deepEqual(await log.overview(estimate), await fromFiles(dir, now));
  assert.ok((await log.prune()).length > 0);
  assert.deepEqual(await log.overview(estimate), await fromFiles(dir, now));
});

test('the overview reads the files once, then serves appends from memory', async () => {
  const dir = await tempDir();
  const now = new Date('2026-10-07T02:00:00Z');
  const log = new ActivityLog(dir, { timeZone: SHANGHAI, now: () => now });
  await log.append({ kind: 'agent_cost', agent: 'qa', costUsd: 0.5 });
  assert.equal((await log.overview()).costs.byAgent.qa, 0.5);
  // Lines written behind the log's back are not read again.
  await fs.appendFile(
    path.join(dir, 'events', '2026-10-07.jsonl'),
    `${JSON.stringify({ kind: 'agent_cost', agent: 'qa', costUsd: 9, at: now.toISOString() })}\n`,
  );
  await log.append({ kind: 'agent_cost', agent: 'qa', costUsd: 0.25 });
  assert.equal((await log.overview()).costs.byAgent.qa, 0.75);
});

test('opening another repository rebuilds the overview from its files', async () => {
  const [first, second] = [await tempDir(), await tempDir()];
  const now = new Date('2026-10-07T02:00:00Z');
  const other = new ActivityLog(second, { timeZone: SHANGHAI, now: () => now });
  await other.append({ kind: 'requirement_created', requirementId: 'b', title: 'b' });
  const log = new ActivityLog(first, { timeZone: SHANGHAI, now: () => now });
  await log.append({ kind: 'requirement_created', requirementId: 'a', title: 'a' });
  assert.deepEqual(
    (await log.overview()).recent.map((record) => record.kind === 'requirement_created' && record.requirementId),
    ['a'],
  );
  await log.open(second);
  assert.deepEqual(
    (await log.overview()).recent.map((record) => record.kind === 'requirement_created' && record.requirementId),
    ['b'],
  );
  await log.append({ kind: 'requirement_created', requirementId: 'c', title: 'c' });
  assert.deepEqual(await log.overview(), await other.overview());
});

test('appends queued while the overview is first built are counted once', async () => {
  const dir = await tempDir();
  const now = new Date('2026-10-07T02:00:00Z');
  const log = new ActivityLog(dir, { timeZone: SHANGHAI, now: () => now });
  const append = () => log.append({ kind: 'agent_cost', agent: 'qa', costUsd: 0.1 });
  const before = Array.from({ length: 10 }, append);
  const overview = log.overview();
  const after = Array.from({ length: 5 }, append);
  await Promise.all([...before, ...after]);
  // The build reads what landed before it; the rest arrive in memory.
  assert.ok(Math.abs((await overview).costs.byAgent.qa - 1) < 1e-9);
  assert.ok(Math.abs((await log.overview()).costs.byAgent.qa - 1.5) < 1e-9);
  assert.deepEqual(await log.overview(), await new ActivityLog(dir, { timeZone: SHANGHAI, now: () => now }).overview());
});
