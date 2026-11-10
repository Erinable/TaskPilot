import { test } from 'vitest';
import assert from 'node:assert/strict';

import { claudeCall, codexCall, codexTokens, codingCall, streamCall } from '../../../src/main/runtimes/model_usage.ts';

const jsonl = (...events: object[]) => events.map((event) => JSON.stringify(event)).join('\n');

test('claudeCall() reads cost, Anthropic token counts and the main model', () => {
  assert.deepEqual(
    claudeCall({
      total_cost_usd: 0.03,
      usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 7, cache_creation_input_tokens: 1 },
      modelUsage: { small: { outputTokens: 1 }, big: { outputTokens: 9 } },
    }),
    { cli: 'claude', provider: 'anthropic', model: 'big', costUsd: 0.03, tokens: { input: 5, output: 2, cacheRead: 7, cacheWrite: 1 } },
  );
  assert.equal(claudeCall({}).tokens, null);
});

test('streamCall() reads pi turn usage and treats a reported 0 cost as unknown', () => {
  // Captured from pi --mode json (2026-10-13), trimmed.
  const usage = { input: 38, output: 24, cacheRead: 0, cacheWrite: 0, reasoning: 21, totalTokens: 62, cost: { total: 0 } };
  const stdout = jsonl(
    { type: 'message_start', message: { role: 'assistant', provider: 'p', model: 'm', usage: { input: 0, output: 0, cost: { total: 0 } } } },
    { type: 'message_end', message: { role: 'assistant', provider: 'lilililwan', model: 'DeepSeek-V4.1-Flash', usage } },
    { type: 'agent_end' },
  );
  assert.deepEqual(streamCall('pi', stdout), {
    cli: 'pi',
    provider: 'lilililwan',
    model: 'DeepSeek-V4.1-Flash',
    costUsd: null,
    tokens: { input: 38, output: 24, cacheRead: 0, cacheWrite: 0 },
  });
  const paid = jsonl({ type: 'turn_end', message: { role: 'assistant', model: 'm', usage: { ...usage, cost: { total: 0.004 } } } });
  assert.equal(streamCall('pi', paid).costUsd, 0.004);
});

test('streamCall() reads grok model and result usage', () => {
  // Captured from grok --output-format streaming-messages-json (2026-10-13), trimmed.
  const stdout = jsonl(
    { type: 'system', model: 'grok-4.7' },
    { type: 'assistant', message: { role: 'assistant', model: 'grok-4.7', content: [{ type: 'text', text: '{}' }] } },
    { type: 'result', usage: { input_tokens: 22780, output_tokens: 303, cache_read_input_tokens: 192, cache_creation_input_tokens: 0 } },
  );
  assert.deepEqual(streamCall('grok', stdout), {
    cli: 'grok',
    provider: 'xai',
    model: 'grok-4.7',
    costUsd: null,
    tokens: { input: 22780, output: 303, cacheRead: 192, cacheWrite: 0 },
  });
});

test('streamCall() sums opencode step_finish tokens and costs', () => {
  const step = (input: number, cost: number) => ({
    type: 'step_finish',
    part: {
      type: 'step-finish',
      providerID: 'openrouter',
      modelID: 'qwen3.8-max',
      cost,
      tokens: { input, output: 2, reasoning: 0, cache: { read: 1, write: 0 } },
    },
  });
  assert.deepEqual(streamCall('opencode', jsonl(step(10, 0.001), step(20, 0.002))), {
    cli: 'opencode',
    provider: 'openrouter',
    model: 'qwen3.8-max',
    costUsd: 0.003,
    tokens: { input: 30, output: 4, cacheRead: 2, cacheWrite: 0 },
  });
});

test('codexCall() keeps standard exec token usage without double counting cached input', () => {
  const stdout = jsonl(
    { type: 'thread.started', thread_id: '0195bd8e-8a90-7000-9c89-ccca8779dafe' },
    { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: '{"ready":true}' } },
    { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 5 } },
  );
  assert.deepEqual(codexCall(stdout, 'gpt-6.1-sol'), {
    cli: 'codex',
    provider: 'openai',
    model: 'gpt-6.1-sol',
    costUsd: null,
    tokens: { input: 60, output: 5, cacheRead: 40, cacheWrite: 0 },
  });
  assert.deepEqual(streamCall('codex', stdout), { ...codexCall(stdout), model: null });
});

test('Codex model metadata takes precedence over selected fallback and is not read from assistant text', () => {
  assert.equal(codexCall(jsonl({ type: 'thread.started', model: 'actual-model' }), 'selected-model').model, 'actual-model');
  assert.equal(codexCall(jsonl({ type: 'turn.started', metadata: { model: '  metadata-model  ' } }), 'selected-model').model, 'metadata-model');
  assert.equal(codexCall(jsonl({ type: 'turn.started', model_id: 'actual-id' }), 'selected-model').model, 'actual-id');
  assert.equal(
    codexCall(jsonl({ type: 'item.completed', item: { type: 'agent_message', text: '{"model":"fabricated"}' } }), ' selected-model ').model,
    'selected-model',
  );
  assert.equal(codexCall('', '  ').model, null);
});

test('Codex retains reported failure usage and ignores malformed or nonfinite counters', () => {
  const failed = jsonl({
    type: 'turn.failed',
    usage: { input_tokens: 12, cached_input_tokens: 3, output_tokens: 1 },
    error: { message: 'failed after billing' },
  });
  assert.deepEqual(codexCall(failed).tokens, { input: 9, output: 1, cacheRead: 3, cacheWrite: 0 });
  const usage = { input_tokens: 10, cached_input_tokens: 2, output_tokens: 0 };
  assert.deepEqual(codexCall(jsonl({ type: 'error', usage })).tokens, { input: 8, output: 0, cacheRead: 2, cacheWrite: 0 });
  assert.equal(codexCall('not-json\n{}').tokens, null);
  assert.equal(codexCall('{"type":"turn.completed","usage":{"input_tokens":1e309,"cached_input_tokens":0,"output_tokens":1}}').tokens, null);
  for (const invalid of [
    null,
    {},
    { input_tokens: 1, output_tokens: 1 },
    { input_tokens: NaN, cached_input_tokens: 0, output_tokens: 1 },
    { input_tokens: Infinity, cached_input_tokens: 0, output_tokens: 1 },
    { input_tokens: 10, cached_input_tokens: -1, output_tokens: 1 },
    { input_tokens: 10, cached_input_tokens: 11, output_tokens: 1 },
    { input_tokens: 10, cached_input_tokens: 1, output_tokens: '1' },
    { input_tokens: 10, cached_input_tokens: 1, output_tokens: 1.5 },
    { input_tokens: Number.MAX_SAFE_INTEGER + 1, cached_input_tokens: 1, output_tokens: 1 },
  ])
    assert.equal(codexTokens(invalid), null);
  assert.deepEqual(codexTokens({ input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test('Codex terminal snapshots are not added twice and invalid late usage does not erase paid evidence', () => {
  const completed = { type: 'turn.completed', usage: { input_tokens: 20, cached_input_tokens: 5, output_tokens: 2 } };
  assert.deepEqual(codexCall(jsonl(completed, completed, { type: 'turn.failed', usage: { input_tokens: null } })).tokens, {
    input: 15,
    output: 2,
    cacheRead: 5,
    cacheWrite: 0,
  });
});

test('codingCall() removes Codex cached input from its input count', () => {
  const usage = { inputTokens: 100, outputTokens: 5, cachedInputTokens: 40, costUsd: null };
  assert.deepEqual(codingCall('codex', 'gpt-6', usage).tokens, { input: 60, output: 5, cacheRead: 40, cacheWrite: 0 });
  assert.deepEqual(codingCall('claude', '', usage).tokens, { input: 100, output: 5, cacheRead: 40, cacheWrite: 0 });
  assert.equal(codingCall('claude', '', usage).model, null);
  assert.equal(codingCall('pi', 'x', { inputTokens: null, outputTokens: null, cachedInputTokens: null, costUsd: 0 }).tokens, null);
});
