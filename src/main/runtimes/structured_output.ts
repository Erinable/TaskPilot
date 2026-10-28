import { AgentRunError } from './claude_cli.ts';
import { isObject } from '../agents/output_validation.ts';

export const hasToolContent = (content: unknown) =>
  Array.isArray(content) && content.some((part) => isObject(part) && (part.type === 'tool_use' || part.type === 'tool_call'));

const initializesAnalysis = (type: string, event: Record<string, unknown>) =>
  type === 'init' || type === 'step_start' || (type === 'system' && event.subtype === 'init');
const hasTools = (tools: unknown) => (Array.isArray(tools) && tools.length > 0) || (isObject(tools) && Object.keys(tools).length > 0);
const isJsonRecord = (value: unknown): value is Record<string, unknown> => isObject(value) && !Array.isArray(value);

export const assertAnalysisEvent = (event: unknown): void => {
  if (!isObject(event) || Array.isArray(event)) return;
  const type = typeof event.type === 'string' ? event.type : '';
  const message = isObject(event.message) ? event.message : event;
  if (type === 'error' || event.is_error === true || message.stopReason === 'error' || (typeof event.subtype === 'string' && event.subtype.startsWith('error')))
    throw new AgentRunError('Agent CLI reported a failed turn', 'agent_failed');
  if (initializesAnalysis(type, event) && hasTools(event.tools))
    throw new AgentRunError('CLI initialized tools in isolated analysis mode', 'agent_unavailable');
  if (type === 'tool' || type === 'tool_execution_start' || type === 'tool_execution_end')
    throw new AgentRunError('CLI attempted a tool in isolated analysis mode', 'agent_unavailable');
  if (hasToolContent(message.content)) throw new AgentRunError('CLI attempted a tool in isolated analysis mode', 'agent_unavailable');
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
