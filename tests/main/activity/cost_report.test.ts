import { test } from 'vitest';
import assert from 'node:assert/strict';

import { buildCostReport } from '../../../src/main/activity/cost_report.ts';
import { buildTable } from '../../../src/main/activity/model_prices.ts';
import type { LoggedRecord } from '../../../src/main/activity/activity_log.ts';
import type { CostRow } from '../../../src/main/activity/cost_rollup.ts';

const NOW = new Date('2026-10-13T04:00:00Z');
const TZ = 'Asia/Shanghai';
const tokens = { input: 1_000_000, output: 100_000, cacheRead: 0, cacheWrite: 0 };
const prices = buildTable(
  { xai: { models: { 'grok-4.7': { canonical_model_id: 'xai/grok-4.7', cost: { input: 2, output: 6 } } } } },
  new Set(['xai']),
  '2026-10-13T00:00:00Z',
);

const cost = (at: string, fields: Partial<LoggedRecord & { kind: 'agent_cost' }>): LoggedRecord =>
  ({ kind: 'agent_cost', agent: 'qa', costUsd: null, at, ...fields }) as LoggedRecord;

const records: LoggedRecord[] = [
  // Reported by the CLI.
  cost('2026-10-13T01:00:00Z', {
    costUsd: 0.1,
    call: { cli: 'claude', provider: 'anthropic', model: 'sonnet', costUsd: 0.1, tokens: null },
    subject: { kind: 'package', id: 'p1' },
  }),
  cost('2026-10-13T02:00:00Z', { costUsd: 0.2, call: { cli: 'claude', provider: 'anthropic', model: 'sonnet', costUsd: 0.2, tokens: null } }),
  // Estimated: 1M input × $2 + 0.1M output × $6 = $2.60.
  cost('2026-10-12T02:00:00Z', {
    agent: 'architect',
    call: { cli: 'grok', provider: 'xai', model: 'grok-4.7', costUsd: null, tokens },
    subject: { kind: 'requirement', id: 'r1' },
  }),
  // Tokens but no price: unknown, and a sync could price it.
  cost('2026-10-12T03:00:00Z', { agent: 'tutor', call: { cli: 'pi', provider: 'custom', model: 'mystery', costUsd: null, tokens } }),
  // Neither: unknown for good.
  cost('2026-10-12T04:00:00Z', { agent: 'tutor', call: { cli: 'pi', provider: null, model: null, costUsd: null, tokens: null } }),
  // A legacy line from before calls were recorded.
  cost('2026-10-11T02:00:00Z', { costUsd: 0.05 }),
  // Not a cost.
  { kind: 'requirement_created', requirementId: 'r1', title: 'x', at: '2026-10-12T00:00:00Z' } as LoggedRecord,
];

const build = (days: 7 | 30 | 90, rollup: CostRow[] = []) =>
  buildCostReport({
    days,
    records,
    rollup,
    prices,
    now: NOW,
    timeZone: TZ,
    titleOf: (kind, id) => `${kind}:${id}`,
  });

test('splits reported, estimated and unknown spend without float drift', () => {
  const { total } = build(7);
  assert.equal(total.calls, 6);
  assert.equal(total.actualUsd, 0.35);
  assert.equal(total.estimatedUsd, 2.6);
  assert.equal(total.unknownCalls, 2);
  assert.equal(total.unpricedCalls, 1);
});

test('groups by agent and model, most spend first; legacy lines have no model', () => {
  const report = build(7);
  assert.deepEqual(
    report.byAgent.map((row) => row.agent),
    ['architect', 'qa', 'tutor'],
  );
  const legacy = report.byModel.find((row) => row.cli === null);
  assert.equal(legacy?.actualUsd, 0.05);
  assert.equal(report.byModel[0].model, 'grok-4.7');
});

test('lists every day of the range, oldest first, and work items with titles', () => {
  const report = build(7);
  assert.equal(report.byDay.length, 7);
  assert.equal(report.byDay.at(-1)?.day, '2026-10-13');
  assert.equal(report.byDay.at(-1)?.actualUsd, 0.3);
  assert.deepEqual(
    report.bySubject.map((row) => [row.kind, row.title]),
    [
      ['requirement', 'requirement:r1'],
      ['package', 'package:p1'],
    ],
  );
});

test('uses the rollup only for days the raw window no longer covers', () => {
  const row = (day: string): CostRow => ({
    day,
    agent: 'qa',
    cli: 'claude',
    provider: 'anthropic',
    model: 'sonnet',
    actualCalls: 2,
    actualMicros: 1_000_000,
    tokenCalls: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    unknownCalls: 0,
  });
  // 2026-08-01 is within 90 days but past the 30-day raw window; 2026-10-12 is raw.
  const report = build(90, [row('2026-08-01'), row('2026-10-12')]);
  assert.equal(report.total.actualUsd, 1.35);
  assert.equal(report.rollupBefore, '2026-09-14');
  assert.equal(build(7, [row('2026-08-01')]).rollupBefore, null);
});
