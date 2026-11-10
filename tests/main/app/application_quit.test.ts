import { expect, onTestFinished, test, vi } from 'vitest';

import { createQuitHandler } from '../../../src/main/app/application_quit.ts';
import { expectConsole } from '../../fixtures/expected_console.ts';

const fixture = (overrides: Partial<Parameters<typeof createQuitHandler>[0]> = {}) => {
  vi.useFakeTimers();
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const shutdown = vi.fn(async () => {});
  const flushLogs = vi.fn(async () => {});
  const quit = vi.fn();
  const handler = createQuitHandler({ shutdown, flushLogs, quit, ...overrides });
  return { shutdown, flushLogs, quit, handler, event: { preventDefault: vi.fn() } };
};

test('one quit drains in order and resumes from a timer task instead of a microtask', async () => {
  const calls: string[] = [];
  const h = fixture({
    shutdown: async () => {
      calls.push('shutdown');
    },
    flushLogs: async () => {
      calls.push('logs');
    },
    quit: () => {
      calls.push('quit');
    },
  });
  expect(h.handler.isQuitting()).toBe(false);
  const pending = h.handler.beforeQuit(h.event);
  expect(h.event.preventDefault).toHaveBeenCalledOnce();
  expect(h.handler.isQuitting()).toBe(true);
  // Flushing every already-queued Promise still must not call native Quit.
  for (let step = 0; step < 8; step += 1) await Promise.resolve();
  expect(calls).toEqual(['shutdown', 'logs']);
  await vi.advanceTimersByTimeAsync(0);
  await pending;
  expect(calls).toEqual(['shutdown', 'logs', 'quit']);
  const resumed = { preventDefault: vi.fn() };
  h.handler.beforeQuit(resumed);
  expect(resumed.preventDefault).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

test('repeated native requests cannot bypass cancellation or unfinished writes', async () => {
  const deferred = Promise.withResolvers<void>();
  const h = fixture({ shutdown: vi.fn(() => deferred.promise) });
  const pending = h.handler.beforeQuit(h.event);
  const second = { preventDefault: vi.fn() };
  expect(h.handler.beforeQuit(second)).toBe(pending);
  expect(second.preventDefault).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(100);
  expect(h.quit).not.toHaveBeenCalled();
  expect(h.flushLogs).not.toHaveBeenCalled();
  deferred.resolve();
  await vi.advanceTimersByTimeAsync(0);
  await pending;
  expect(h.flushLogs).toHaveBeenCalledOnce();
  expect(h.quit).toHaveBeenCalledOnce();
});

test('failed shutdown is logged and still flushes logs before completing the same quit', async () => {
  expectConsole('error', /\[shutdown\] could not finish background runs/);
  const h = fixture({
    shutdown: async () => {
      throw new Error('fixture write failure');
    },
  });
  const pending = h.handler.beforeQuit(h.event);
  await vi.advanceTimersByTimeAsync(0);
  await pending;
  expect(h.flushLogs).toHaveBeenCalledOnce();
  expect(h.quit).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

test('failed log flush does not require another exit action', async () => {
  expectConsole('error', /\[shutdown\] could not flush logs/);
  const h = fixture({
    flushLogs: async () => {
      throw new Error('fixture log failure');
    },
  });
  const pending = h.handler.beforeQuit(h.event);
  await vi.advanceTimersByTimeAsync(0);
  await pending;
  expect(h.quit).toHaveBeenCalledOnce();
});

for (const stage of ['shutdown', 'flushLogs'] as const) {
  test(`the total deadline includes a hanging ${stage}`, async () => {
    expectConsole('error', /\[shutdown\] cleanup deadline exceeded/);
    const blocked = Promise.withResolvers<void>();
    const h = fixture({ [stage]: () => blocked.promise });
    const pending = h.handler.beforeQuit(h.event);
    await vi.advanceTimersByTimeAsync(2999);
    expect(h.quit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    await pending;
    expect(h.quit).toHaveBeenCalledOnce();
    blocked.resolve();
    await vi.advanceTimersByTimeAsync(100);
    expect(h.quit).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
}

test('requests between cleanup completion and the resume timer remain prevented', async () => {
  const h = fixture();
  const pending = h.handler.beforeQuit(h.event);
  for (let step = 0; step < 8; step += 1) await Promise.resolve();
  const event = { preventDefault: vi.fn() };
  expect(h.handler.beforeQuit(event)).toBe(pending);
  expect(event.preventDefault).toHaveBeenCalledOnce();
  expect(h.quit).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(0);
  await pending;
  expect(h.quit).toHaveBeenCalledOnce();
});
