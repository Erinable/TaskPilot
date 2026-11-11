import { test } from 'vitest';
import assert from 'node:assert/strict';

import { assertAnalysisEvent, parseCodexAnalysisOutput, parseStructuredOutput } from '../../../src/main/runtimes/structured_output.ts';

const jsonl = (...events: object[]) => events.map((event) => JSON.stringify(event)).join('\n');
const usage = { input_tokens: 450, cached_input_tokens: 320, output_tokens: 27 };
const started = { type: 'turn.started' };
const message = (text = '{"ready":true}', id = 'item_1') => ({ type: 'item.completed', item: { id, type: 'agent_message', text } });
const completed = { type: 'turn.completed', usage };
const codexFixture = [
  { type: 'thread.started', thread_id: '0195bd8e-8a90-7000-9c89-ccca8779dafe' },
  started,
  { type: 'item.started', item: { id: 'item_0', type: 'reasoning', text: '' } },
  { type: 'item.updated', item: { id: 'item_0', type: 'reasoning', text: 'Check the supplied interface.' } },
  { type: 'item.completed', item: { id: 'item_0', type: 'reasoning', text: 'Only summarize the supplied interface.' } },
  message('{"title":"模块接口","modules":[]}'),
  completed,
];

// Codex exec --json shape: item objects carry id/type/text, while token usage
// belongs to turn.completed. This fixture never starts a real CLI or model.
test('Codex analysis accepts complete event JSONL and keeps reasoning out of the result', () => {
  assert.deepEqual(parseCodexAnalysisOutput(jsonl(...codexFixture)), { title: '模块接口', modules: [] });
  assert.deepEqual(parseCodexAnalysisOutput(jsonl(started, message(), completed)), { ready: true });
  for (const event of codexFixture) assertAnalysisEvent(event, 'codex');
});

test('Codex uses the last completed assistant message rather than concatenating messages or reasoning', () => {
  assert.deepEqual(
    parseCodexAnalysisOutput(
      jsonl(
        started,
        message('A short progress update.', 'item_0'),
        message('{"old":true}', 'item_1'),
        { type: 'item.completed', item: { id: 'item_2', type: 'reasoning_summary', text: '{"reasoning":"never use this"}' } },
        message('{"final":true}', 'item_3'),
        completed,
      ),
    ),
    { final: true },
  );
});

const tools = [
  'command_execution',
  'file_change',
  'mcp_tool_call',
  'web_search',
  'tool',
  'plan',
  'tool_call',
  'function_call',
  'custom_tool_call',
  'image_generation',
  'browser',
  'computer',
  'subagent',
  'collab_tool_call',
  'todo_list',
  'new_future_tool',
];
for (const type of tools) {
  for (const eventType of ['item.started', 'item.updated', 'item.completed']) {
    test(`Codex analysis rejects ${type} at ${eventType}, including after a valid result`, () => {
      const tool = { type: eventType, item: { id: 'unsafe', type, text: '{"ok":true}' } };
      assert.throws(() => assertAnalysisEvent(tool), { code: 'agent_unavailable' });
      assert.throws(() => assertAnalysisEvent(tool, 'codex'), { code: 'agent_unavailable' });
      assert.throws(() => parseCodexAnalysisOutput(jsonl(started, message(), tool, completed)), { code: 'agent_unavailable' });
      assert.throws(() => parseCodexAnalysisOutput(jsonl(started, message(), completed, tool)), { code: 'agent_unavailable' });
    });
  }
}

for (const failure of [
  { type: 'turn.failed', error: { message: 'request rejected' }, usage },
  { type: 'error', message: 'transport failed' },
]) {
  test(`Codex ${failure.type} overrides an earlier message or completed turn`, () => {
    assert.throws(() => assertAnalysisEvent(failure), { code: 'agent_failed' });
    assert.throws(() => parseCodexAnalysisOutput(jsonl(started, message(), failure)), { code: 'agent_failed' });
    assert.throws(() => parseCodexAnalysisOutput(jsonl(started, message(), completed, failure)), { code: 'agent_failed' });
  });
}

for (const input of [
  '',
  '{}',
  '{"ready":true}',
  '{"type":"result","structured_output":{"ready":true}}',
  '[{"ready":true}]',
  jsonl(started, message()),
  jsonl(message(), completed),
  jsonl(started, completed),
  jsonl(started, { type: 'item.started', item: { id: 'pending', type: 'agent_message', text: '{"ready":true}' } }, message(), completed),
  jsonl(started, message(), completed, { type: 'thread.started', thread_id: 'unexpected' }),
  jsonl(started, message(), started, completed),
  jsonl(started, message(), { type: 'turn.cancelled' }),
  jsonl(started, { type: 'item.delta', item: { id: 'unknown', type: 'agent_message', text: '{}' } }, completed),
  jsonl(started, { type: 'item.completed', item: { type: 'agent_message', text: '{}' } }, completed),
  jsonl(started, { type: 'item.completed', item: { id: 'missing-text', type: 'agent_message' } }, completed),
  `${jsonl(started, message(), completed)}\n{"type":`,
]) {
  test(`Codex refuses incomplete or non-Codex analysis output: ${input.slice(0, 100) || '(empty)'}`, () => {
    assert.throws(() => parseCodexAnalysisOutput(input), { code: 'agent_bad_output' });
  });
}

for (const text of ['not JSON', '```json\n{"ok":true}\n```', '[]', 'null', 'true', '123', '"text"', '{"partial":']) {
  test(`Codex final assistant message must be one valid JSON object: ${text}`, () => {
    assert.throws(() => parseCodexAnalysisOutput(jsonl(started, message('{"prior":true}', 'prior'), message(text), completed)), { code: 'agent_bad_output' });
  });
}

for (const invalidUsage of [
  undefined,
  null,
  {},
  { input_tokens: 10, output_tokens: 2 },
  { input_tokens: '10', cached_input_tokens: 0, output_tokens: 2 },
  { input_tokens: 10, cached_input_tokens: 11, output_tokens: 2 },
  { input_tokens: -1, cached_input_tokens: 0, output_tokens: 2 },
  { input_tokens: 10, cached_input_tokens: 0, output_tokens: 0.5 },
  { input_tokens: Number.MAX_SAFE_INTEGER + 1, cached_input_tokens: 0, output_tokens: 2 },
]) {
  test(`Codex requires valid terminal token usage: ${JSON.stringify(invalidUsage)}`, () => {
    const event = { type: 'turn.completed', usage: invalidUsage };
    assert.throws(() => assertAnalysisEvent(event, 'codex'), { code: 'agent_bad_output' });
    assert.throws(() => parseCodexAnalysisOutput(jsonl(started, message(), event)), { code: 'agent_bad_output' });
  });
}

test('Codex rejects nonfinite wire counts and hidden tools even in nominal text items', () => {
  assert.throws(
    () =>
      parseCodexAnalysisOutput(
        `${jsonl(started, message())}\n{"type":"turn.completed","usage":{"input_tokens":1e309,"cached_input_tokens":0,"output_tokens":1}}`,
      ),
    { code: 'agent_bad_output' },
  );
  assert.throws(() => assertAnalysisEvent({ type: 'item.completed', item: { id: 'hidden', type: 'agent_message', text: '{}', tools: ['read'] } }, 'codex'), {
    code: 'agent_unavailable',
  });
  assert.throws(() => assertAnalysisEvent({ type: 'item.completed', item: { id: 'hidden', type: 'reasoning', content: [{ type: 'tool_call' }] } }, 'codex'), {
    code: 'agent_unavailable',
  });
});

test('strict Codex checks leave the other analysis envelope formats unchanged', () => {
  assert.deepEqual(parseStructuredOutput('{"type":"assistant","message":{"content":"{\\"pi\\":true}"}}'), { pi: true });
  assert.deepEqual(parseStructuredOutput('{"type":"text","part":{"type":"text","text":"{\\"opencode\\":true}"}}'), { opencode: true });
  assert.deepEqual(parseStructuredOutput('{"result":{"grok":true}}'), { grok: true });
  assert.deepEqual(parseStructuredOutput('{"raw":true}'), { raw: true });
});

test.each([
  { type: 'error', message: "Invalid schema: 'schema.properties.configuration.oneOf' is not permitted when strict is true." },
  { type: 'turn.failed', error: { message: "Invalid schema: 'schema.properties.configuration.oneOf' is not permitted when strict is true." } },
])('Codex $type retains the provider reason rather than only a generic failure', (event) => {
  assert.throws(
    () => assertAnalysisEvent(event, 'codex'),
    (error: unknown) => {
      assert.equal((error as { code: string }).code, 'agent_failed');
      assert.match((error as Error).message, /configuration.oneOf.*not permitted/);
      return true;
    },
  );
});

test('provider failure messages are bounded and credentials are redacted', () => {
  const message = `request rejected api_key=fixture-api-key Authorization: Bearer fixture-bearer ${'x'.repeat(5000)}`;
  assert.throws(
    () => assertAnalysisEvent({ type: 'error', message }, 'codex'),
    (error: unknown) => {
      const failure = error as Error;
      assert.match(failure.message, /request rejected/);
      assert.doesNotMatch(failure.message, /fixture-api-key|fixture-bearer/);
      assert.ok(failure.message.length < 2100);
      return true;
    },
  );
});
