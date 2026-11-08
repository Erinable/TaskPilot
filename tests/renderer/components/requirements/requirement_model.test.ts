// @vitest-environment happy-dom
import { expect, test } from 'vitest';

import { rowDate } from '../../../../src/renderer/src/components/requirements/requirement_model.ts';

test('a list row dates its requirement in the business time zone', () => {
  // 17:00 UTC on 30 September is already 1 October in Shanghai.
  expect(rowDate('2026-09-30T17:00:00Z')).toBe('10月1日');
  expect(rowDate('2026-09-30T17:00:00Z', 'UTC')).toBe('9月30日');
});
