import { AgentRunError } from './claude_cli.ts';
import { isObject } from '../agents/output_validation.ts';
import { codexTokens } from './model_usage.ts';
import type { CliId } from '../../shared/agent_runtime.ts';

export const hasToolContent = (content: unknown) =>
  Array.isArray(content) && content.some((part) => isObject(part) && (part.type === 'tool_use' || part.type === 'tool_call'));

const initializesAnalysis = (type: string, event: Record<string, unknown>) =>
  type === 'init' || type === 'step_start' || (type === 'system' && event.subtype === 'init');
const hasTools = (tools: unknown) => (Array.isArray(tools) && tools.length > 0) || (isObject(tools) && Object.keys(tools).length > 0);
const isJsonRecord = (value: unknown): value is Record<string, unknown> => isObject(value) && !Array.isArray(value);

const CODEX_ITEM_EVENTS = new Set(['item.started', 'item.updated', 'item.completed']);
const CODEX_TEXT_ITEMS = new Set(['agent_message', 'reasoning', 'reasoning_summary']);
const CODEX_EVENTS = new Set(['thread.started', 'turn.started', 'turn.completed', 'turn.failed', 'error', ...CODEX_ITEM_EVENTS]);
const codexEvent = (type: string) => ['thread.', 'turn.', 'item.'].some((prefix) => type.startsWith(prefix));

const assertCodexEvent = (event: Record<string, unknown>, type: string) => {
  if (!CODEX_EVENTS.has(type)) throw new AgentRunError('Codex emitted an unknown analysis event', 'agent_bad_output');
  if (type === 'turn.failed' || type === 'error') throw new AgentRunError('Codex reported a failed analysis turn', 'agent_failed');
  if (hasTools(event.tools)) throw new AgentRunError('Codex initialized tools in isolated analysis mode', 'agent_unavailable');
  if (type === 'turn.completed' && codexTokens(event.usage) === null)
    throw new AgentRunError('Codex completed a turn without valid token usage', 'agent_bad_output');
  if (!CODEX_ITEM_EVENTS.has(type)) return;
  if (!isJsonRecord(event.item)) throw new AgentRunError('Codex emitted an invalid analysis item', 'agent_bad_output');
  const item = event.item;
  // The whitelist deliberately rejects unknown future items too. These checks
  // reject an observed unsafe stream; they do not prevent tool execution.
  if (!CODEX_TEXT_ITEMS.has(String(item.type)) || hasTools(item.tools) || hasToolContent(item.content))
    throw new AgentRunError('Codex emitted a tool or unsupported item in isolated analysis mode', 'agent_unavailable');
  if (type === 'item.completed' && item.type === 'agent_message' && typeof item.text !== 'string')
    throw new AgentRunError('Codex completed an assistant message without text', 'agent_bad_output');
};

export const assertAnalysisEvent = (event: unknown, cli?: CliId): void => {
  if (!isObject(event) || Array.isArray(event)) {
    if (cli === 'codex') throw new AgentRunError('Codex emitted a non-object analysis event', 'agent_bad_output');
    return;
  }
  const type = typeof event.type === 'string' ? event.type : '';
  const message = isObject(event.message) ? event.message : event;
  if (type === 'error' || event.is_error === true || message.stopReason === 'error' || (typeof event.subtype === 'string' && event.subtype.startsWith('error')))
    throw new AgentRunError('Agent CLI reported a failed turn', 'agent_failed');
  if (initializesAnalysis(type, event) && hasTools(event.tools))
    throw new AgentRunError('CLI initialized tools in isolated analysis mode', 'agent_unavailable');
  if (type === 'tool' || type === 'tool_execution_start' || type === 'tool_execution_end')
    throw new AgentRunError('CLI attempted a tool in isolated analysis mode', 'agent_unavailable');
  if (hasToolContent(message.content)) throw new AgentRunError('CLI attempted a tool in isolated analysis mode', 'agent_unavailable');
  if (cli === 'codex' || codexEvent(type)) assertCodexEvent(event, type);
};

const assistantText = (message: Record<string, unknown>): string[] => {
  if (typeof message.role === 'string' && message.role !== 'assistant') return [];
  const content = message.content;
  if (typeof content === 'string') return [content];
  const parts: string[] = [];
  if (!Array.isArray(content)) return parts;
  for (const part of content) {
    if (!isObject(part) || Array.isArray(part)) continue;
    if (part.type === 'tool_use' || part.type === 'tool_call') throw new AgentRunError('CLI attempted a tool in isolated analysis mode', 'agent_unavailable');
    if (part.type === 'text' && typeof part.text === 'string') parts.push(part.text);
  }
  return parts;
};

const structuredResult = (structured: unknown, result: unknown, assistant: string[], rawObject: Record<string, unknown> | null): unknown => {
  if (isObject(structured) && !Array.isArray(structured)) return structured;
  if (isObject(result) && !Array.isArray(result)) return result;
  const text = typeof result === 'string' ? result : assistant.join('\n').trim();
  if (text) {
    try {
      const value: unknown = JSON.parse(text);
      if (isObject(value) && !Array.isArray(value)) return value;
    } catch {
      throw new AgentRunError('Agent did not return structured JSON output', 'agent_bad_output');
    }
  }
  if (rawObject) return rawObject;
  throw new AgentRunError('Agent did not return structured JSON output', 'agent_bad_output');
};

type CodexAnalysisState = { started: boolean; completed: boolean; threadSeen: boolean; finalText: string | null; pendingItems: Set<string> };

const acceptCodexEvent = (state: CodexAnalysisState, event: Record<string, unknown>) => {
  const type = event.type as string;
  if (state.completed) throw new AgentRunError('Codex emitted events after its completed analysis turn', 'agent_bad_output');
  if (type === 'thread.started') {
    if (state.started || state.threadSeen) throw new AgentRunError('Codex emitted an unexpected thread start', 'agent_bad_output');
    state.threadSeen = true;
    return;
  }
  if (type === 'turn.started') {
    if (state.started) throw new AgentRunError('Codex emitted more than one analysis turn', 'agent_bad_output');
    state.started = true;
    return;
  }
  if (!state.started) throw new AgentRunError('Codex emitted analysis output before its turn started', 'agent_bad_output');
  if (type === 'turn.completed') {
    if (state.pendingItems.size) throw new AgentRunError('Codex completed its turn with unfinished analysis items', 'agent_bad_output');
    state.completed = true;
    return;
  }
  const item = event.item as Record<string, unknown>;
  if (typeof item.id !== 'string' || !item.id) throw new AgentRunError('Codex emitted an analysis item without an identity', 'agent_bad_output');
  if (type === 'item.started' || type === 'item.updated') state.pendingItems.add(item.id);
  if (type === 'item.completed') {
    state.pendingItems.delete(item.id);
    if (item.type === 'agent_message') state.finalText = item.text as string;
  }
};

// Codex exec produces event JSONL rather than a bare response. Accept only a
// finished turn and the last completed agent message, never reasoning fragments
// or output from another CLI's envelope.
export const parseCodexAnalysisOutput = (input: string): unknown => {
  const state: CodexAnalysisState = { started: false, completed: false, threadSeen: false, finalText: null, pendingItems: new Set() };
  for (const line of input.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new AgentRunError('Codex emitted invalid analysis JSONL', 'agent_bad_output');
    }
    assertAnalysisEvent(parsed, 'codex');
    acceptCodexEvent(state, parsed as Record<string, unknown>);
  }
  if (!state.started || !state.completed || state.finalText === null)
    throw new AgentRunError('Codex did not finish a structured analysis turn', 'agent_bad_output');
  let output: unknown;
  try {
    output = JSON.parse(state.finalText);
  } catch {
    throw new AgentRunError('Codex did not return a valid JSON object', 'agent_bad_output');
  }
  if (!isJsonRecord(output)) throw new AgentRunError('Codex did not return a JSON object', 'agent_bad_output');
  return output;
};

export const parseStructuredOutput = (input: string): unknown => {
  const assistant: string[] = [];
  let structured: unknown;
  let result: unknown;
  let rawObject: Record<string, unknown> | null = null;
  for (const line of input.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new AgentRunError('Agent emitted invalid JSONL', 'agent_bad_output');
    }
    if (!isJsonRecord(parsed)) continue;
    const event = parsed;
    const type = typeof event.type === 'string' ? event.type : '';
    const message = isJsonRecord(event.message) ? event.message : event;
    assertAnalysisEvent(event);
    if (isJsonRecord(event.structured_output)) structured = event.structured_output;
    if (type === 'result' || (!type && 'result' in event)) result = event.result;
    if (!type && !('result' in event) && !('structured_output' in event)) rawObject = event;
    if (['message_end', 'assistant', 'message'].includes(type)) assistant.push(...assistantText(message));
    if (type === 'text') {
      if (isObject(event.part) && typeof event.part.text === 'string') assistant.push(event.part.text);
      else if (typeof event.text === 'string') assistant.push(event.text);
    }
  }
  // Validate the entire stream before accepting a success: a later terminal
  // failure or tool event must not be hidden by an earlier JSON result.
  return structuredResult(structured, result, assistant, rawObject);
};
