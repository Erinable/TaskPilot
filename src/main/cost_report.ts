// The cost page's numbers: raw cost records for the last 30 business days,
// rollup rows before that, grouped by agent, day, model and work item.
// Sums are integer micro-dollars and become dollars only at the end.
import type * as activityTypes from '../shared/ipc/activity.ts';
import type { AgentId } from '../shared/agent_runtime.ts';
import { businessDay, recentDays, RETENTION_DAYS } from './activity_log.ts';
import type { LoggedRecord } from './activity_log.ts';
import { foldCosts } from './cost_rollup.ts';
import type { CostRow } from './cost_rollup.ts';
import { estimateMicros, priceFor } from './model_prices.ts';
import type { PriceTable } from './model_prices.ts';

type Micros = { calls: number; actual: number; estimated: number; unknown: number; unpriced: number; tokens: activityTypes.TokenUsage };

const empty = (): Micros => ({ calls: 0, actual: 0, estimated: 0, unknown: 0, unpriced: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });

// One row's contribution, priced with the current table.
const priced = (row: CostRow, prices: PriceTable | null): Micros => {
  const price = row.tokenCalls ? priceFor(prices, row.provider, row.model) : null;
  return {
    calls: row.actualCalls + row.tokenCalls + row.unknownCalls,
    actual: row.actualMicros,
    estimated: price ? estimateMicros(price, row.tokens) : 0,
    unknown: row.unknownCalls + (price ? 0 : row.tokenCalls),
    unpriced: price ? 0 : row.tokenCalls,
    tokens: row.tokens,
  };
};

const add = (into: Micros, part: Micros) => {
  into.calls += part.calls;
  into.actual += part.actual;
  into.estimated += part.estimated;
  into.unknown += part.unknown;
  into.unpriced += part.unpriced;
  into.tokens.input += part.tokens.input;
  into.tokens.output += part.tokens.output;
  into.tokens.cacheRead += part.tokens.cacheRead;
  into.tokens.cacheWrite += part.tokens.cacheWrite;
};

const bucket = (micros: Micros): activityTypes.CostBucket => ({
  calls: micros.calls,
  actualUsd: micros.actual / 1_000_000,
  estimatedUsd: micros.estimated / 1_000_000,
  unknownCalls: micros.unknown,
  unpricedCalls: micros.unpriced,
  tokens: micros.tokens,
});

// Sums `rows` by `keyOf`, keeping each group's first row for its labels.
const group = <Row extends CostRow>(rows: { row: Row; micros: Micros }[], keyOf: (row: Row) => string) => {
  const groups = new Map<string, { row: Row; micros: Micros }>();
  for (const { row, micros } of rows) {
    const key = keyOf(row);
    const entry = groups.get(key) ?? { row, micros: empty() };
    add(entry.micros, micros);
    groups.set(key, entry);
  }
  return [...groups.values()];
};

const spend = (micros: Micros) => micros.actual + micros.estimated;

export const buildCostReport = ({
  days,
  records,
  rollup,
  prices,
  now,
  timeZone,
  titleOf,
}: {
  days: activityTypes.CostRange;
  // Raw records of the last RETENTION_DAYS business days.
  records: LoggedRecord[];
  rollup: CostRow[];
  prices: PriceTable | null;
  now: Date;
  timeZone: string;
  titleOf: (kind: 'package' | 'requirement', id: string) => string;
}): activityTypes.CostReport => {
  const window = recentDays(now, timeZone, days);
  const inWindow = new Set(window);
  const rawOldest = recentDays(now, timeZone, RETENTION_DAYS).at(-1) as string;
  const raw = foldCosts(
    records,
    (record) => businessDay(new Date(record.at), timeZone),
    (record) => ({ subjectKind: record.subject?.kind ?? null, subjectId: record.subject?.id ?? null }),
  ).filter((row) => inWindow.has(row.day));
  // Rollup rows cover only days the raw window no longer holds.
  const older = rollup.filter((row) => inWindow.has(row.day) && row.day < rawOldest).map((row) => ({ ...row, subjectKind: null, subjectId: null }));
  const rows = [...raw, ...older].map((row) => ({ row, micros: priced(row, prices) }));

  const total = empty();
  for (const { micros } of rows) add(total, micros);
  const bySpend = <Entry extends { micros: Micros }>(entries: Entry[]) => entries.sort((left, right) => spend(right.micros) - spend(left.micros));

  return {
    days,
    timeZone,
    total: bucket(total),
    byAgent: bySpend(group(rows, (row) => row.agent)).map(({ row, micros }) => ({ ...bucket(micros), agent: row.agent as AgentId })),
    byDay: [...window].reverse().map((day) => {
      const micros = empty();
      for (const entry of rows) if (entry.row.day === day) add(micros, entry.micros);
      return { ...bucket(micros), day };
    }),
    byModel: bySpend(group(rows, (row) => [row.cli ?? '', row.provider ?? '', row.model ?? ''].join('\u0000'))).map(({ row, micros }) => ({
      ...bucket(micros),
      cli: row.cli,
      provider: row.provider,
      model: row.model,
    })),
    bySubject: bySpend(
      group(
        rows.filter(({ row }) => row.subjectKind && row.subjectId),
        (row) => `${row.subjectKind}\u0000${row.subjectId}`,
      ),
    ).map(({ row, micros }) => {
      const kind = row.subjectKind as 'package' | 'requirement';
      const id = row.subjectId as string;
      return { ...bucket(micros), kind, id, title: titleOf(kind, id) };
    }),
    rollupBefore: older.length ? rawOldest : null,
    prices: prices ? { syncedAt: prices.syncedAt } : null,
  };
};
