// Display helpers for the cost page.
import { AGENT_LABELS } from '@shared/agent_runtime.ts';
import type * as ipc from '@shared/ipc_types.ts';

export const RANGE_OPTIONS: { label: string; value: ipc.CostRange }[] = [
  { label: '7 天', value: 7 },
  { label: '30 天', value: 30 },
  { label: '90 天', value: 90 },
];

export const usd = (value: number) => (value === 0 ? '$0.00' : `$${value.toFixed(value < 1 ? 3 : 2)}`);

// Reported plus estimated; the parts are shown beside it.
export const spendOf = (bucket: ipc.CostBucket) => bucket.actualUsd + bucket.estimatedUsd;

export const spendText = (bucket: ipc.CostBucket) => {
  const parts = [bucket.estimatedUsd > 0 ? `含估算 ${usd(bucket.estimatedUsd)}` : '', bucket.unknownCalls > 0 ? `${bucket.unknownCalls} 次未知` : '']
    .filter(Boolean)
    .join(' · ');
  return { amount: usd(spendOf(bucket)), detail: parts };
};

const compact = (value: number) => (value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M` : value >= 1000 ? `${(value / 1000).toFixed(1)}k` : `${value}`);
export const tokensText = (tokens: ipc.TokenUsage) => {
  const input = tokens.input + tokens.cacheRead + tokens.cacheWrite;
  return input || tokens.output ? `${compact(input)} 入 / ${compact(tokens.output)} 出` : '–';
};

export const agentName = (agent: ipc.AgentId) => AGENT_LABELS[agent] ?? agent;

export const modelName = (row: { cli: ipc.CliId | null; provider: string | null; model: string | null }) =>
  row.cli === null ? '未记录模型' : [row.provider, row.model ?? '默认模型'].filter(Boolean).join(' / ');

// The tallest day sets 100% of the bar chart. A day with any spend keeps a
// 2% sliver so it stays visible; a day with none has no bar.
export const barHeights = (byDay: ipc.CostBucket[]) => {
  const top = Math.max(...byDay.map(spendOf), 0);
  return byDay.map((bucket) => {
    const spend = spendOf(bucket);
    return top > 0 && spend > 0 ? Math.max(2, Math.round((spend / top) * 100)) : 0;
  });
};
