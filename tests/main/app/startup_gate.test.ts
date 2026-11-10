import { expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';

import { captureExpectedErrors } from '../../fixtures/expected_errors.ts';
import { expectConsole } from '../../fixtures/expected_console.ts';
import { tempDir } from '../../fixtures/temp_dir.ts';
import { createStartupGate } from '../../../src/main/app/startup_gate.ts';
import * as preferences from '../../../src/main/app/preferences.ts';
test('callers share the attempt in flight, and a success is never repeated', async () => {
  const initialize = vi.fn(async () => {});
  const gate = createStartupGate(initialize);
  await Promise.all([gate.ready(false), gate.ready(false), gate.ready(true)]);
  await gate.ready(true);
  expect(initialize).toHaveBeenCalledOnce();
});

test('a failure reaches every caller until a retry starts over', async () => {
  const diskError = new Error('disk full');
  captureExpectedErrors((error) => error === diskError);
  const initialize = vi.fn().mockRejectedValueOnce(diskError).mockResolvedValueOnce(undefined);
  const gate = createStartupGate(initialize);
  await expect(gate.ready(false)).rejects.toThrow('disk full');
  await expect(gate.ready(false)).rejects.toThrow('disk full');
  expect(initialize).toHaveBeenCalledOnce();
  await expect(gate.ready(true)).resolves.toBeUndefined();
  await gate.ready(true);
  expect(initialize).toHaveBeenCalledTimes(2);
});

test('corrupt startup data stays visible until the preserved file is repaired and retried', { tags: ['integration'] }, async () => {
  const directory = await tempDir('taskpilot-startup-corruption-');
  const file = path.join(directory, preferences.PREFERENCES_FILENAME);
  await fs.writeFile(file, '{ broken');
  const failures = expectConsole('error', /\[startup\] initialization failed.*应用数据文件已损坏/);
  const gate = createStartupGate(async () => {
    await preferences.load(directory);
  });
  const expected = { code: 'storage_corrupt', message: expect.stringContaining(file) };
  await expect(gate.ready(false)).rejects.toMatchObject(expected);
  await expect(gate.ready(false)).rejects.toMatchObject(expected);
  expect(await fs.readFile(file, 'utf8')).toBe('{ broken');
  expect(failures).toHaveLength(1);
  await fs.writeFile(file, JSON.stringify({ version: 1, ...preferences.defaults() }));
  await expect(gate.ready(true)).resolves.toBeUndefined();
  await expect(gate.ready(false)).resolves.toBeUndefined();
});
