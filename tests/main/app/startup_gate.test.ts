import { expect, test, vi } from 'vitest';

import { createStartupGate } from '../../../src/main/app/startup_gate.ts';

test('callers share the attempt in flight, and a success is never repeated', async () => {
  const initialize = vi.fn(async () => {});
  const gate = createStartupGate(initialize);
  await Promise.all([gate.ready(false), gate.ready(false), gate.ready(true)]);
  await gate.ready(true);
  expect(initialize).toHaveBeenCalledOnce();
});

test('a failure reaches every caller until a retry starts over', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const initialize = vi.fn().mockRejectedValueOnce(new Error('disk full')).mockResolvedValueOnce(undefined);
  const gate = createStartupGate(initialize);
  await expect(gate.ready(false)).rejects.toThrow('disk full');
  await expect(gate.ready(false)).rejects.toThrow('disk full');
  expect(initialize).toHaveBeenCalledOnce();
  await expect(gate.ready(true)).resolves.toBeUndefined();
  await gate.ready(true);
  expect(initialize).toHaveBeenCalledTimes(2);
});
