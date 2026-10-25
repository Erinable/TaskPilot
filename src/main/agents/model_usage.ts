// Reads what a CLI reported about one analysis call: the provider and model
// it ran on, its token counts and, when the CLI knows it, the cost.
// Formats checked against each CLI's JSON output (2026-10-13):
//   claude   final envelope: total_cost_usd, usage (Anthropic counts), modelUsage keyed by model
//   pi       message_end / turn_end: message.{provider, model, usage{input, output, cacheRead, cacheWrite, cost.total}}
//   grok     system / assistant: model; result: usage (Anthropic counts)
//   opencode step_finish per step: part.{tokens{input, output, cache{read, write}}, cost}, providerID/modelID
// A reported cost of 0 is treated as unknown: CLIs report 0 for providers
// they have no price for, not only for free ones.
import type { CliId, ModelCall, TokenUsage } from '../../shared/ipc_types.ts';

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0);
const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);
const paid = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null);

// Anthropic-style counts, which Claude and Grok both report.
const anthropicTokens = (usage: unknown): TokenUsage | null =>
  isObject(usage)
    ? {
        input: count(usage.input_tokens),
        output: count(usage.output_tokens),
        cacheRead: count(usage.cache_read_input_tokens),
        cacheWrite: count(usage.cache_creation_input_tokens),
      }
    : null;

const addTokens = (left: TokenUsage | null, right: TokenUsage): TokenUsage =>
  left
    ? {
        input: left.input + right.input,
        output: left.output + right.output,
        cacheRead: left.cacheRead + right.cacheRead,
        cacheWrite: left.cacheWrite + right.cacheWrite,
      }
    : right;

// Claude's single JSON envelope. The model is the modelUsage entry that
// produced the most output (a run can touch a small helper model too).
export const claudeCall = (envelope: { total_cost_usd?: unknown; usage?: unknown; modelUsage?: unknown }): ModelCall => {
  const models = isObject(envelope.modelUsage) ? Object.entries(envelope.modelUsage) : [];
  const main = models.sort(([, left], [, right]) => count(isObject(right) ? right.outputTokens : 0) - count(isObject(left) ? left.outputTokens : 0))[0];
  return { cli: 'claude', provider: 'anthropic', model: main?.[0] ?? null, costUsd: paid(envelope.total_cost_usd), tokens: anthropicTokens(envelope.usage) };
};

// The JSONL stream of an analysis call through pi, grok or opencode.
const updatePiCall = (call: ModelCall, type: string, message: Json) => {
  if ((type !== 'message_end' && type !== 'turn_end') || message.role !== 'assistant' || !isObject(message.usage)) return;
  const usage = message.usage;
  call.provider = text(message.provider) ?? call.provider;
  call.model = text(message.model) ?? call.model;
  call.tokens = { input: count(usage.input), output: count(usage.output), cacheRead: count(usage.cacheRead), cacheWrite: count(usage.cacheWrite) };
  call.costUsd = paid(isObject(usage.cost) ? usage.cost.total : null);
};

const updateOpenCodeCall = (call: ModelCall, type: string, event: Json): number => {
  const part = isObject(event.part) ? event.part : {};
  call.provider = text(part.providerID) ?? text(event.providerID) ?? call.provider;
  call.model = text(part.modelID) ?? text(event.modelID) ?? call.model;
  if (type !== 'step_finish' || !isObject(part.tokens)) return 0;
  const cache = isObject(part.tokens.cache) ? part.tokens.cache : {};
  call.tokens = addTokens(call.tokens, {
    input: count(part.tokens.input),
    output: count(part.tokens.output),
    cacheRead: count(cache.read),
    cacheWrite: count(cache.write),
  });
  return count(part.cost);
};

export const streamCall = (cli: Exclude<CliId, 'claude' | 'codex'>, stdout: string): ModelCall => {
  const call: ModelCall = { cli, provider: cli === 'grok' ? 'xai' : null, model: null, costUsd: null, tokens: null };
  let opencodeCost = 0;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(event)) continue;
    const type = typeof event.type === 'string' ? event.type : '';
    const message = isObject(event.message) ? event.message : event;
    if (cli === 'pi') updatePiCall(call, type, message);
    if (cli === 'grok') {
      call.model = text(message.model) ?? text(event.model) ?? call.model;
      if (type === 'result') call.tokens = anthropicTokens(event.usage) ?? call.tokens;
    }
    if (cli === 'opencode') opencodeCost += updateOpenCodeCall(call, type, event);
  }
  if (cli === 'opencode') call.costUsd = paid(opencodeCost);
  return call;
};

// A coding run's usage as coding_exec.ts parsed it. Codex counts cached
// input inside input_tokens; the other CLIs report it separately.
export const codingCall = (
  cli: CliId,
  model: string,
  usage: { inputTokens: number | null; outputTokens: number | null; cachedInputTokens: number | null; costUsd: number | null },
): ModelCall => {
  const cached = count(usage.cachedInputTokens);
  const tokens =
    usage.inputTokens === null && usage.outputTokens === null
      ? null
      : { input: Math.max(0, count(usage.inputTokens) - (cli === 'codex' ? cached : 0)), output: count(usage.outputTokens), cacheRead: cached, cacheWrite: 0 };
  return { cli, provider: CODING_PROVIDERS[cli] ?? null, model: text(model), costUsd: paid(usage.costUsd), tokens };
};

// Providers a CLI always runs on; pi and opencode route to many.
const CODING_PROVIDERS: Partial<Record<CliId, string>> = { claude: 'anthropic', grok: 'xai', codex: 'openai' };
