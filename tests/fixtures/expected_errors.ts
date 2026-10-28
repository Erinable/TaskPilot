import { onTestFinished, vi } from 'vitest';
import assert from 'node:assert/strict';

import { logger } from '../../src/main/infrastructure/logger.ts';

// Only a named failure is quiet; unexpected errors still reach stderr and fail the test.
export const captureExpectedErrors = (matches: (error: Error) => boolean) => {
  const original = logger.error.bind(logger);
  const unexpected: unknown[][] = [];
  const errors = vi.spyOn(logger, 'error').mockImplementation((...values) => {
    if (values.some((value) => value instanceof Error && matches(value))) return;
    unexpected.push(values);
    original(...values);
  });
  onTestFinished(() => {
    errors.mockRestore();
    assert.deepEqual(unexpected, [], 'Unexpected application errors were logged');
  });
};
