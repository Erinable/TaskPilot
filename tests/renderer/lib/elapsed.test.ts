// @vitest-environment happy-dom
// useNow(): the clock ticks only while mounted and active.
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, h, nextTick, ref } from 'vue';
import type { Ref } from 'vue';

import { elapsedSince, formatElapsed, useNow } from '@/lib/elapsed.ts';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-28T00:00:00Z'));
});

afterEach(() => vi.useRealTimers());

const mountClock = (active?: () => boolean) => {
  const clock: { now: Ref<number> | null } = { now: null };
  const Clock = defineComponent({
    setup: () => {
      const now = active ? useNow(active) : useNow();
      clock.now = now;
      return () => h('span', String(now.value));
    },
  });
  const wrapper = mount(Clock);
  return { wrapper, now: () => clock.now!.value };
};

test('without an active flag the clock ticks every second until unmounted', () => {
  const { wrapper, now } = mountClock();
  const start = now();
  vi.advanceTimersByTime(3000);
  expect(now()).toBe(start + 3000);
  wrapper.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

test('an inactive clock keeps no timer; turning active reads the time and ticks, inactive stops again', async () => {
  const running = ref(false);
  const { wrapper, now } = mountClock(() => running.value);
  expect(vi.getTimerCount()).toBe(0);
  const start = now();
  vi.advanceTimersByTime(5000);
  expect(now()).toBe(start);

  running.value = true;
  await nextTick();
  expect(now()).toBe(start + 5000);
  expect(vi.getTimerCount()).toBe(1);
  vi.advanceTimersByTime(2000);
  expect(now()).toBe(start + 7000);

  running.value = false;
  await nextTick();
  expect(vi.getTimerCount()).toBe(0);
  vi.advanceTimersByTime(2000);
  expect(now()).toBe(start + 7000);

  running.value = true;
  await nextTick();
  wrapper.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

test('elapsed text in plain words', () => {
  expect(formatElapsed(45_000)).toBe('45 秒');
  expect(formatElapsed(192_000)).toBe('3 分 12 秒');
  expect(elapsedSince('not a date', 0)).toBeNull();
});
