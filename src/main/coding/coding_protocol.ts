import type { AgentRuntimeConfig } from '../../shared/agent_runtime.ts';
import type { CodingEvent, CodingUsage } from '../../shared/coding_types.ts';
import { CodingExecError, MAX_OUTPUT_BYTES, MAX_TRANSCRIPT_BYTES } from './coding_process.ts';

export type EventSink = (event: CodingEvent) => void;
export type Transcript = { bytes: number };

export const emptyUsage = (): CodingUsage => ({
  inputTokens: null,
  outputTokens: null,
  cachedInputTokens: null,
  reasoningTokens: null,
  costUsd: null,
});

export const redact = (value: string): string =>
  value
    .replace(/(sk-[A-Za-z0-9_-]{12,})/g, '[REDACTED_TOKEN]')
    .replace(/((?:api[_-]?key|token|secret|password)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]');

const textOf = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join('');
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of ['text', 'value', 'content']) {
      if (key in record) {
        const text = textOf(record[key]);
        if (text) return text;
      }
    }
  }
  return '';
};

const eventAt = () => new Date().toISOString();

const addEvent = (events: CodingEvent[], type: CodingEvent['type'], text: string, sink?: EventSink, transcript?: Transcript) => {
  if (!text) return;
  const remaining = MAX_TRANSCRIPT_BYTES - (transcript?.bytes ?? 0);
  if (remaining <= 0) return;
  const bounded = Buffer.byteLength(text) <= remaining ? text : Buffer.from(text).subarray(0, remaining).toString('utf8');
  if (transcript) transcript.bytes += Buffer.byteLength(bounded);
  const event = { sequence: events.length, at: eventAt(), type, text: bounded } satisfies CodingEvent;
  events.push(event);
  try {
    sink?.(event);
  } catch {
    // Event observers must not interrupt the coding run.
  }
};

const usageNumber = (record: Record<string, unknown>, key: string): number | null =>
  typeof record[key] === 'number' && Number.isFinite(record[key]) ? record[key] : null;

type RecordContext = {
  cli: AgentRuntimeConfig['cli'];
  events: CodingEvent[];
  output: { text: string; bytes: number };
  usage: CodingUsage;
  sink?: EventSink;
  transcript?: Transcript;
};

const objectOf = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' ? (value as Record<string, unknown>) : {});

const appendOutput = (text: string, context: RecordContext) => {
  const { cli, output, events, sink, transcript } = context;
  const bytes = Buffer.byteLength(text);
  if (output.bytes + bytes > MAX_OUTPUT_BYTES) throw new CodingExecError(`${cli === 'codex' ? 'Codex' : cli} output exceeded the limit`, 'coding_oversized');
  output.bytes += bytes;
  if (text) output.text += `${output.text ? '\n' : ''}${text}`;
  addEvent(events, 'text', text, sink, transcript);
};

const isNativeFailure = (type: string, value: Record<string, unknown>, message: Record<string, unknown>, context: RecordContext) =>
  type === 'error' ||
  type.endsWith('.error') ||
  type === 'agent_error' ||
  value.is_error === true ||
  message.stopReason === 'error' ||
  value.stopReason === 'error' ||
  (context.cli === 'pi' && type === 'agent_end' && Boolean(value.error ?? value.error_message ?? message.error));

const isAssistantMessage = (cli: AgentRuntimeConfig['cli'], type: string, message: Record<string, unknown>) => {
  if (cli === 'claude') return type === 'assistant';
  if (cli === 'pi') return type === 'message_end' && (!message.role || message.role === 'assistant');
  return cli === 'grok' && ['assistant', 'message', 'message_end'].includes(type) && (!message.role || message.role === 'assistant');
};

const assistantChunks = (message: Record<string, unknown>, context: RecordContext): string[] => {
  const { events, sink, transcript } = context;
  if (typeof message.content === 'string') return [message.content];
  const chunks: string[] = [];
  if (!Array.isArray(message.content)) return chunks;
  for (const rawBlock of message.content) {
    if (!rawBlock || typeof rawBlock !== 'object') continue;
    const block = rawBlock as Record<string, unknown>;
    if (block.type === 'thinking' || block.type === 'reasoning') addEvent(events, 'thinking', textOf(block.thinking ?? block.text), sink, transcript);
    else if (block.type === 'tool_use' || block.type === 'tool_call') addEvent(events, 'tool', textOf(block.name ?? block.tool ?? block.id), sink, transcript);
    else if (block.type === 'text') chunks.push(textOf(block.text));
  }
  return chunks;
};

const nativeText = (type: string, value: Record<string, unknown>, message: Record<string, unknown>, part: Record<string, unknown>, context: RecordContext) => {
  const { cli, events, sink, transcript } = context;
  const assistant = isAssistantMessage(cli, type, message);
  const chunks = assistant ? assistantChunks(message, context) : [];
  if (cli === 'pi' && type === 'tool_execution_start') addEvent(events, 'tool', textOf(value.toolName ?? value.tool_name ?? value.name), sink, transcript);
  if (cli === 'opencode') {
    if (type === 'tool') addEvent(events, 'tool', textOf(part.tool ?? value.tool ?? value.name), sink, transcript);
    if (type === 'reasoning' || part.type === 'reasoning') addEvent(events, 'thinking', textOf(part.text ?? value.text), sink, transcript);
    if (type === 'text') chunks.push(textOf(part.text ?? value.text));
  }
  if (cli === 'grok' && assistant && !chunks.length) chunks.push(textOf(message.content ?? value.content ?? value.text));
  return chunks.join('');
};

const firstUsageNumber = (value: Record<string, unknown>, keys: string[], fallback: number | null) =>
  keys.map((key) => usageNumber(value, key)).find((number) => number !== null) ?? fallback;

const updateNativeUsage = (value: Record<string, unknown>, message: Record<string, unknown>, usage: CodingUsage) => {
  const usageValue = message.usage && typeof message.usage === 'object' ? objectOf(message.usage) : objectOf(value.usage);
  usage.inputTokens = firstUsageNumber(usageValue, ['input_tokens', 'inputTokens', 'prompt_tokens'], usage.inputTokens);
  usage.outputTokens = firstUsageNumber(usageValue, ['output_tokens', 'outputTokens', 'completion_tokens'], usage.outputTokens);
  usage.cachedInputTokens = firstUsageNumber(usageValue, ['cache_read_input_tokens', 'cached_input_tokens', 'cached_tokens'], usage.cachedInputTokens);
  usage.reasoningTokens = firstUsageNumber(usageValue, ['reasoning_tokens', 'reasoning_output_tokens'], usage.reasoningTokens);
  usage.costUsd = usageNumber(value, 'total_cost_usd') ?? usageNumber(usageValue, 'cost_usd') ?? usage.costUsd;
};

const addOpenCodeUsage = (part: Record<string, unknown>, usage: CodingUsage) => {
  if (!part.tokens || typeof part.tokens !== 'object') return;
  const tokens = objectOf(part.tokens);
  const cache = objectOf(tokens.cache);
  const add = (current: number | null, next: number | null) => (next === null ? current : (current ?? 0) + next);
  usage.inputTokens = add(usage.inputTokens, usageNumber(tokens, 'input'));
  usage.outputTokens = add(usage.outputTokens, usageNumber(tokens, 'output'));
  usage.cachedInputTokens = add(usage.cachedInputTokens, usageNumber(cache, 'read'));
  usage.reasoningTokens = add(usage.reasoningTokens, usageNumber(tokens, 'reasoning'));
  usage.costUsd = add(usage.costUsd, usageNumber(part, 'cost'));
};

const parseNativeRecord = (type: string, value: Record<string, unknown>, context: RecordContext): { failed?: string } => {
  const message = objectOf(value.message);
  const part = objectOf(value.part);
  if (isNativeFailure(type, value, message, context)) {
    const nativeError = value.error ?? value.error_message ?? message.error;
    const reason = redact(textOf(nativeError ?? value.message ?? value.detail ?? value.result) || `${context.cli} reported an error`);
    addEvent(context.events, 'error', reason, context.sink, context.transcript);
    return { failed: reason };
  }
  const text = nativeText(type, value, message, part, context);
  if (text) appendOutput(text, context);
  updateNativeUsage(value, message, context.usage);
  if (context.cli === 'opencode' && type === 'step_finish') addOpenCodeUsage(part, context.usage);
  return {};
};

const parseCodexItem = (type: string, item: Record<string, unknown>, context: RecordContext) => {
  const { events, sink, transcript } = context;
  const itemType = typeof item.type === 'string' ? item.type : '';
  if (itemType === 'agent_message') {
    const text = textOf(item.text ?? item.content);
    if (type === 'item.completed') appendOutput(text, context);
    else addEvent(events, 'text', text, sink, transcript);
  } else if (itemType === 'reasoning' || itemType === 'reasoning_summary') {
    addEvent(events, 'thinking', textOf(item.text ?? item.summary ?? item.content), sink, transcript);
  } else if (itemType) {
    const label = textOf(item.name ?? item.command ?? item.text);
    addEvent(events, 'tool', `${itemType}${label ? `: ${label}` : ''}`, sink, transcript);
  }
};

const parseCodexRecord = (type: string, value: Record<string, unknown>, context: RecordContext): { failed?: string } => {
  if (['item.started', 'item.updated', 'item.completed'].includes(type)) parseCodexItem(type, objectOf(value.item), context);
  else if (type === 'turn.completed') {
    const usage = value.usage && typeof value.usage === 'object' ? objectOf(value.usage) : value;
    context.usage.inputTokens = usageNumber(usage, 'input_tokens');
    context.usage.cachedInputTokens = usageNumber(usage, 'cached_input_tokens');
    context.usage.outputTokens = usageNumber(usage, 'output_tokens');
    context.usage.reasoningTokens = usageNumber(usage, 'reasoning_output_tokens');
  } else if (type === 'turn.failed' || type === 'error') {
    const message = redact(textOf(value.error ?? value.message ?? value.detail) || 'Codex reported an error');
    addEvent(context.events, 'error', message, context.sink, context.transcript);
    return { failed: message };
  }
  return {};
};

export const parseRecord = (
  raw: string,
  cli: AgentRuntimeConfig['cli'],
  events: CodingEvent[],
  output: { text: string; bytes: number },
  usage: CodingUsage,
  sink?: EventSink,
  transcript?: Transcript,
): { failed?: string } => {
  let record: unknown;
  try {
    record = JSON.parse(raw);
  } catch {
    throw new CodingExecError('Codex emitted invalid JSONL', 'coding_protocol');
  }
  if (!record || typeof record !== 'object') return {};
  const value = record as Record<string, unknown>;
  const type = typeof value.type === 'string' ? value.type : '';
  const context = { cli, events, output, usage, sink, transcript };
  return cli === 'codex' ? parseCodexRecord(type, value, context) : parseNativeRecord(type, value, context);
};
