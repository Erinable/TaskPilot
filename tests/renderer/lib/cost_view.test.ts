import { test } from 'vitest';
import assert from 'node:assert/strict';

import * as view from '../../../src/renderer/src/lib/cost_view.ts';

const bucket = (actualUsd: number, estimatedUsd = 0, unknownCalls = 0) => ({
  calls: 1,
  actualUsd,
  estimatedUsd,
  unknownCalls,
  unpricedCalls: 0,
  tokens: { input: 1500, output: 2_000_000, cacheRead: 500, cacheWrite: 0 },
});

test('spendText() adds estimates to the amount and names them, with unknown calls', () => {
  assert.deepEqual(view.spendText(bucket(1, 0.5, 2)), { amount: '$1.50', detail: '含估算 $0.500 · 2 次未知' });
  assert.deepEqual(view.spendText(bucket(0)), { amount: '$0.00', detail: '' });
});

test('tokensText() counts cache tokens as input', () => assert.equal(view.tokensText(bucket(0).tokens), '2.0k 入 / 2.0M 出'));

test('modelName() marks lines recorded before models were', () => {
  assert.equal(view.modelName({ cli: null, provider: null, model: null }), '未记录模型');
  assert.equal(view.modelName({ cli: 'pi', provider: 'deepseek', model: null }), 'deepseek / 默认模型');
});

test('barHeights() scales to the busiest day and keeps small days visible', () => {
  assert.deepEqual(view.barHeights([bucket(0), bucket(0.01), bucket(1)]), [0, 2, 100]);
  assert.deepEqual(view.barHeights([bucket(0)]), [0]);
});
