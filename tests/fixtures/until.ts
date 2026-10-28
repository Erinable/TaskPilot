// The one wait for state another process or the OS changes (file watchers,
// child processes, a held run's phase). The deadline is the running test's
// own timeout less a margin, so a slow machine fails with the last value
// instead of a bare timeout, and no test hard-codes milliseconds.
import { TestRunner } from 'vitest';

export const until = async <Value>(read: () => Value | Promise<Value>, done: (value: Value) => boolean, label: string): Promise<Value> => {
  const timeout = TestRunner.getCurrentTest()?.timeout;
  if (!timeout) throw new Error('until() runs inside a test');
  const deadline = Date.now() + timeout * 0.9;
  let last: Value | undefined;
  while (Date.now() < deadline) {
    last = await read();
    if (done(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`${label} timed out; last value: ${JSON.stringify(last)}`);
};
