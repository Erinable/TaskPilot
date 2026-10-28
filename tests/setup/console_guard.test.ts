// The console guard itself: only output a test declared is quiet. Calls are
// recorded straight into expected_console.ts so these tests can pass.
import { expect, test } from 'vitest';

import { logger } from '../../src/main/infrastructure/logger.ts';
import { expectConsole, recordConsole, takeUnexpected } from '../fixtures/expected_console.ts';

test('an expected call is quiet and returned; another level or text is not', () => {
  const calls = expectConsole('error', /refresh failed/);
  expect(recordConsole('error', ['[x] refresh failed', new Error('boom')])).toBe(true);
  expect(recordConsole('warn', ['[x] refresh failed'])).toBe(false);
  expect(recordConsole('error', ['[x] something else'])).toBe(false);
  expect(calls).toHaveLength(1);
  expect(takeUnexpected().map(({ level, text }) => `${level} ${text}`)).toEqual(['warn [x] refresh failed', 'error [x] something else']);
});

test('expectations end with the test that declared them', () => {
  expectConsole('error', /boom/);
  takeUnexpected();
  expect(recordConsole('error', ['boom'])).toBe(false);
  takeUnexpected();
});

test('the main-process logger goes through the guard', () => {
  const calls = expectConsole('warn', /\[notes\] watcher failed/);
  logger.warn('[notes] watcher failed', new Error('EMFILE'));
  logger.info('[notes] info is never guarded');
  expect(calls).toHaveLength(1);
});
