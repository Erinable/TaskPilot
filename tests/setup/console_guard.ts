// Fails a test that writes an error or warning it did not expect
// (tests/fixtures/expected_console.ts): Vue warnings, a store's failed load,
// a call no fake answers, or a main-process logger error.
import { afterEach } from 'vitest';

import { logger } from '../../src/main/infrastructure/logger.ts';
import { recordConsole, takeUnexpected } from '../fixtures/expected_console.ts';
import type { ConsoleLevel } from '../fixtures/expected_console.ts';

const original = { error: console.error.bind(console), warn: console.warn.bind(console) };
for (const level of ['error', 'warn'] as const) {
  console[level] = (...values: unknown[]) => {
    if (!recordConsole(level, values)) original[level](...values);
  };
}
logger.configure({
  sink: (level, values) => {
    if (level === 'error' || level === 'warn') recordConsole(level as ConsoleLevel, values);
  },
});

afterEach(() => {
  const found = takeUnexpected();
  if (found.length)
    throw new Error(`Unexpected console output (expectConsole() if intended):\n${found.map(({ level, text }) => `[${level}] ${text}`).join('\n')}`);
});
