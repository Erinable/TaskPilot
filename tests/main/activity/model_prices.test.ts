import { test } from 'vitest';
import assert from 'node:assert/strict';

import { tempDir } from '../../fixtures/temp_dir.ts';
import { buildTable, estimateMicros, loadPrices, priceFor, PRICES_URL, syncPrices } from '../../../src/main/activity/model_prices.ts';
import type { FetchFn } from '../../../src/main/activity/model_prices.ts';

// A slice of models.dev's api.json shape.
const MODELS_DEV = {
  xai: { models: { 'grok-4.7': { canonical_model_id: 'xai/grok-4.7', cost: { input: 2, output: 6, cache_read: 0.5 } } } },
  deepseek: {
    models: { 'deepseek-v4.1-flash': { canonical_model_id: 'deepseek/deepseek-v4.1-flash', cost: { input: 0.15, output: 0.6, cache_read: 0.003 } } },
  },
  // A reseller: never borrowed for another provider.
  openrouter: { models: { 'deepseek/deepseek-v4.1-flash': { canonical_model_id: 'deepseek/deepseek-v4.1-flash', cost: { input: 0.0441, output: 0.63 } } } },
  opencode: { models: { 'big-pickle': { cost: { input: 0, output: 0 } } } },
};

test('buildTable() keeps exact prices only for used providers, plus first-party prices', () => {
  const table = buildTable(MODELS_DEV, new Set(['openrouter', 'opencode']), 't');
  assert.deepEqual(Object.keys(table.exact), ['openrouter']);
  assert.deepEqual(table.firstParty, { 'xai/grok-4.7': [2, 6, 0.5, null], 'deepseek/deepseek-v4.1-flash': [0.15, 0.6, 0.003, null] });
});

test('priceFor() matches exactly, then by the first-party model name, never a reseller', () => {
  const table = buildTable(MODELS_DEV, new Set(['openrouter']), 't');
  assert.deepEqual(priceFor(table, 'openrouter', 'DeepSeek/DeepSeek-V4.1-Flash'), [0.0441, 0.63, null, null]);
  // A custom provider name (as pi reports it) falls back to the lab's own price.
  assert.deepEqual(priceFor(table, 'lilililwan', 'DeepSeek-V4.1-Flash'), [0.15, 0.6, 0.003, null]);
  assert.equal(priceFor(table, 'opencode', 'big-pickle'), null);
  assert.equal(priceFor(table, 'xai', null), null);
  assert.equal(priceFor(null, 'xai', 'grok-4.7'), null);
});

test('estimateMicros() prices each token kind and falls back to the input price for cache', () => {
  const tokens = { input: 1000, output: 100, cacheRead: 200, cacheWrite: 10 };
  // 1000×2 + 100×6 + 200×0.5 + 10×2 (no write price) micro-dollars.
  assert.equal(estimateMicros([2, 6, 0.5, null], tokens), 2720);
});

test('syncPrices() downloads with a timeout, saves the table, and loadPrices() reads it back', async () => {
  const dir = await tempDir('taskpilot-prices-');
  const requests: { url: string; signal: AbortSignal }[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    requests.push({ url, signal: init.signal });
    return { ok: true, status: 200, text: async () => JSON.stringify(MODELS_DEV) };
  };
  assert.equal(await loadPrices(dir), null);
  const table = await syncPrices(dir, new Set(['xai']), { fetchFn, now: () => new Date('2026-10-13T08:00:00Z') });
  assert.equal(requests[0].url, PRICES_URL);
  assert.ok(requests[0].signal instanceof AbortSignal);
  assert.deepEqual(await loadPrices(dir), table);
  assert.equal(table.syncedAt, '2026-10-13T08:00:00.000Z');
});

test('syncPrices() reports a failed download and keeps the previous table', async () => {
  const dir = await tempDir('taskpilot-prices-');
  const good: FetchFn = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(MODELS_DEV) });
  const saved = await syncPrices(dir, new Set(), { fetchFn: good });
  await assert.rejects(() => syncPrices(dir, new Set(), { fetchFn: async () => ({ ok: false, status: 503, text: async () => '' }) }), {
    code: 'prices_unavailable',
  });
  await assert.rejects(() => syncPrices(dir, new Set(), { fetchFn: async () => ({ ok: true, status: 200, text: async () => 'not json' }) }), {
    code: 'prices_invalid',
  });
  assert.deepEqual(await loadPrices(dir), saved);
});
