// @vitest-environment happy-dom
// Displayed times follow the business time zone, whatever the system's is,
// and each (time zone, shape) builds its formatter once.
import { afterEach, expect, test, vi } from 'vitest';

import * as timeZone from '../../../src/renderer/src/lib/time_zone.ts';

afterEach(() => vi.restoreAllMocks());

const AT = new Date('2026-09-30T17:05:09Z');

test('days, clock times and date-times are read in the given time zone', () => {
  expect(timeZone.businessDay(AT, 'Asia/Shanghai')).toBe('2026-10-01');
  expect(timeZone.businessDay(AT, 'UTC')).toBe('2026-09-30');
  expect(timeZone.businessClock(AT, 'Asia/Shanghai')).toBe('01:05:09');
  expect(timeZone.businessClock(new Date('2026-09-30T16:00:00Z'), 'Asia/Shanghai')).toBe('00:00:00');
  expect(timeZone.businessDateTime(AT, 'Asia/Shanghai')).toBe('2026-10-01 01:05:09');
  expect(timeZone.businessDateTime(AT, 'America/New_York')).toBe('2026-09-30 13:05:09');
  expect(timeZone.businessMonthDay(AT, 'Asia/Shanghai')).toBe('10月1日');
});

test('the default is the business time zone the preload passes in', () => {
  expect(timeZone.businessTimeZone()).toBe('Asia/Shanghai');
  expect(timeZone.businessDateTime(AT)).toBe('2026-10-01 01:05:09');
});

test('formatting many times builds one formatter per time zone and shape', () => {
  const built = vi.spyOn(Intl, 'DateTimeFormat');
  for (let index = 0; index < 50; index += 1) {
    timeZone.businessDay(new Date(AT.getTime() + index * 3_600_000), 'Europe/Berlin');
    timeZone.businessDateTime(AT, 'Europe/Berlin');
  }
  timeZone.businessDay(AT, 'Asia/Tokyo');
  expect(built).toHaveBeenCalledTimes(3);
});

test('the day before crosses month ends', () => {
  expect(timeZone.previousDay('2026-10-01')).toBe('2026-09-30');
});
