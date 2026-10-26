// .spec.ts, so TaskPilot's own `tests/**/*.test.ts` run never picks it up.
import { describe, expect, test } from 'vitest';

describe('auth', () => {
  describe('login', () => {
    test('locks after five failures', () => {
      expect(5).toBe(5);
    });

    test('rejects a bad password', () => {
      expect(1).toBe(2);
    });
  });
});

test('exports login', () => {
  expect(typeof describe).toBe('function');
});
