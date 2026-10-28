import { test } from 'vitest';
import assert from 'node:assert/strict';
import { asAgentError } from '../../../src/main/infrastructure/coded_error.ts';
import { toFailure } from '../../../src/main/ipc/handler.ts';

test('normalizes null and primitive caught values', () => {
  assert.deepEqual(asAgentError(null), { code: 'unknown', message: 'null' });
  assert.deepEqual(asAgentError(42), { code: 'unknown', message: '42' });
  assert.deepEqual(toFailure('boom'), { ok: false, error: { code: 'unknown', message: 'boom' } });
});

test('does not trust arbitrary error codes', () => {
  const error = Object.assign(new Error('bad'), { code: 'made_up_code' });
  assert.deepEqual(asAgentError(error), { code: 'unknown', message: 'bad' });
  assert.deepEqual(toFailure(error), { ok: false, error: { code: 'unknown', message: 'bad' } });
});

test('preserves known application codes and fields', () => {
  const error = Object.assign(new Error('invalid input'), { code: 'invalid_argument', field: 'name' });
  assert.deepEqual(toFailure(error), { ok: false, error: { code: 'invalid_argument', message: 'invalid input', field: 'name' } });
  assert.deepEqual(toFailure({ code: 'invalid_argument', message: 'invalid input', field: 'name' }), {
    ok: false,
    error: { code: 'invalid_argument', message: 'invalid input', field: 'name' },
  });
});
