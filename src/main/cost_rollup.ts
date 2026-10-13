// Daily cost totals kept after the raw events expire. Before a day file is
// pruned, its agent_cost lines are folded into one row per agent, CLI,
// provider and model, so spend stays visible for a year without the raw
// lines. Rows keep raw token sums (not dollars) so a later price sync still
// prices them.
//
// [人工决策-2026-10-13 16:52:32] 原始记录保留 30 天；「天 × 成员 × 模型」汇总保留 1 年，存 events/cost_rollup.json。
import type { AgentId, CliId, TokenUsage } from '../shared/ipc_types.ts';
import type { LoggedRecord } from './activity_log.ts';

export const ROLLUP_FILENAME = 'cost_rollup.json';
export const ROLLUP_DAYS = 365;

// Calls are split three ways: priced by the CLI, with token counts only, or
// with neither. `tokens` sums only the second group.
export type CostRow = {
  day: string;
  agent: AgentId;
  cli: CliId | null;
  provider: string | null;
  model: string | null;
  actualCalls: number;
  // Integer millionths of a dollar: sums of floats drift, sums of integers do not.
  actualMicros: number;
  tokenCalls: number;
  tokens: TokenUsage;
  unknownCalls: number;
};

// Dollars to integer micro-dollars, the unit every cost sum uses.
export const toMicros = (usd: number): number => Math.round(usd * 1_000_000);

const emptyTokens = (): TokenUsage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const keyOf = (row: Pick<CostRow, 'day' | 'agent' | 'cli' | 'provider' | 'model'>) =>
  [row.day, row.agent, row.cli ?? '', row.provider ?? '', row.model ?? ''].join('\u0000');

// Groups cost records into rows; `dayOf` gives each record's business day.
// Extra keys from `groupBy` (the subject, for the cost page) split rows further.
export const foldCosts = <Extra extends Record<string, string | null> = Record<never, never>>(
  records: LoggedRecord[],
  dayOf: (record: LoggedRecord) => string,
  groupBy: (record: LoggedRecord & { kind: 'agent_cost' }) => Extra = () => ({}) as Extra,
): (CostRow & Extra)[] => {
  const rows = new Map<string, CostRow & Extra>();
  for (const record of records) {
    if (record.kind !== 'agent_cost') continue;
    const call = record.call;
    const extra = groupBy(record);
    const identity = { day: dayOf(record), agent: record.agent, cli: call?.cli ?? null, provider: call?.provider ?? null, model: call?.model ?? null };
    const key = [keyOf(identity), ...Object.values(extra).map((value) => value ?? '')].join('\u0000');
    let row = rows.get(key);
    if (!row) {
      row = { ...identity, actualCalls: 0, actualMicros: 0, tokenCalls: 0, tokens: emptyTokens(), unknownCalls: 0, ...extra };
      rows.set(key, row);
    }
    const cost = record.costUsd;
    if (typeof cost === 'number' && Number.isFinite(cost) && cost > 0) {
      row.actualCalls += 1;
      row.actualMicros += toMicros(cost);
    } else if (call?.tokens) {
      row.tokenCalls += 1;
      row.tokens.input += call.tokens.input;
      row.tokens.output += call.tokens.output;
      row.tokens.cacheRead += call.tokens.cacheRead;
      row.tokens.cacheWrite += call.tokens.cacheWrite;
    } else row.unknownCalls += 1;
  }
  return [...rows.values()];
};

// Rows for `days` replace whatever the rollup held for those days, so folding
// a day twice (a prune that stopped before deleting) never double counts.
// Rows older than `oldest` are dropped.
export const mergeRollup = (existing: CostRow[], folded: CostRow[], days: string[], oldest: string): CostRow[] => {
  const replaced = new Set(days);
  return [...existing.filter((row) => !replaced.has(row.day)), ...folded]
    .filter((row) => row.day >= oldest)
    .sort((left, right) => left.day.localeCompare(right.day));
};

// A rollup file read back: rows that do not look like rows are dropped.
export const parseRollup = (raw: unknown): CostRow[] => {
  const rows = (raw as { rows?: unknown } | null)?.rows;
  if (!Array.isArray(rows)) return [];
  return rows.filter(
    (row): row is CostRow =>
      typeof row === 'object' &&
      row !== null &&
      typeof row.day === 'string' &&
      typeof row.agent === 'string' &&
      Number.isInteger(row.actualMicros) &&
      Number.isFinite(row.actualCalls) &&
      Number.isFinite(row.tokenCalls) &&
      Number.isFinite(row.unknownCalls) &&
      typeof row.tokens === 'object' &&
      row.tokens !== null,
  );
};
