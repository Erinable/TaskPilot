import { expect, test } from 'vitest';

import { compareVersions } from '../../src/shared/semver.ts';

test('compareVersions orders releases and puts a prerelease before its release', () => {
  expect(compareVersions('1.2.0', '1.10.0')).toBeLessThan(0);
  expect(compareVersions('2.0.0', '1.9.9')).toBeGreaterThan(0);
  expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBeLessThan(0);
  expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
  expect(compareVersions(null, '0.1.0')).toBeLessThan(0);
  expect(compareVersions('0.1.0', 'not a version')).toBeGreaterThan(0);
});
