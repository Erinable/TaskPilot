import { onTestFinished, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { readdir, readFile, stat, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createLogger, MAX_LOG_BYTES } from '../../../src/main/infrastructure/logger.ts';
import { tempDir } from '../../fixtures/temp_dir.ts';

test('filters levels and preserves write order', async () => {
  const dir = await tempDir('taskpilot-log-');
  const logger = createLogger({ level: 'warn', sink: () => {} });
  await logger.initialize(dir);
  logger.info('hidden');
  logger.warn('first');
  logger.error('second');
  await logger.flush();
  const text = await readFile(path.join(dir, 'taskpilot.log'), 'utf8');
  assert.match(text, /\[warn\] first/);
  assert.match(text, /\[error\] second/);
  assert.doesNotMatch(text, /hidden/);
  assert.ok(text.indexOf('first') < text.indexOf('second'));
  assert.equal((await stat(path.join(dir, 'taskpilot.log'))).mode & 0o777, 0o600);
});

test('serializes errors and circular values safely', async () => {
  const dir = await tempDir('taskpilot-log-');
  const logger = createLogger({ level: 'debug', sink: () => {} });
  await logger.initialize(dir);
  const value: { self?: unknown } = {};
  value.self = value;
  const error = Object.assign(new Error('bad'), { code: 'E_BAD' });
  logger.error(error, value);
  logger.warn({
    get value() {
      throw new Error('broken getter');
    },
  });
  await logger.flush();
  const text = await readFile(path.join(dir, 'taskpilot.log'), 'utf8');
  assert.match(text, /bad/);
  assert.match(text, /E_BAD/);
  assert.match(text, /Circular/);
  assert.match(text, /Unserializable/);
});

test('an unwritable log path cannot fail business callers or overwrite the blocking file', async () => {
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  onTestFinished(() => stderr.mockRestore());
  const dir = await tempDir('taskpilot-log-');
  const blocked = path.join(dir, 'blocked');
  const logger = createLogger({ sink: () => {} });
  await logger.initialize(blocked);
  await rm(blocked, { recursive: true });
  await writeFile(blocked, 'keep');
  logger.error('could not append');
  await logger.flush();
  await logger.initialize(path.join(blocked, 'nested'));
  logger.warn('still safe');
  await logger.flush();
  assert.equal(await readFile(blocked, 'utf8'), 'keep');
  const errors = stderr.mock.calls.map(([line]) => {
    assert.match(String(line), /^\[error\] log write failed /);
    return JSON.parse(String(line).slice('[error] log write failed '.length)) as { code: string; message: string };
  });
  assert.deepEqual(
    errors.map((error) => error.code),
    ['ENOTDIR', 'ENOTDIR'],
  );
  assert.ok(errors[0].message.includes(path.join(blocked, 'taskpilot.log')));
  assert.ok(errors[1].message.includes(path.join(blocked, 'nested')));
});

test('initialize() rotates a log above the size cap, keeping three old logs at 0600', async () => {
  const dir = await tempDir('taskpilot-log-');
  const file = path.join(dir, 'taskpilot.log');
  await writeFile(file, 'x'.repeat(MAX_LOG_BYTES + 1), { mode: 0o644 });
  for (const index of [1, 2, 3]) await writeFile(`${file}.${index}`, `old ${index}`);
  const logger = createLogger({ sink: () => {} });
  await logger.initialize(dir);
  logger.info('fresh');
  await logger.flush();
  assert.match(await readFile(file, 'utf8'), /\[info\] fresh/);
  assert.equal((await stat(`${file}.1`)).size, MAX_LOG_BYTES + 1);
  assert.equal((await stat(`${file}.1`)).mode & 0o777, 0o600);
  assert.equal(await readFile(`${file}.2`, 'utf8'), 'old 1');
  assert.equal(await readFile(`${file}.3`, 'utf8'), 'old 2');
  assert.deepEqual((await readdir(dir)).sort(), ['taskpilot.log', 'taskpilot.log.1', 'taskpilot.log.2', 'taskpilot.log.3']);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test('initialize() keeps a log at or below the size cap in place', async () => {
  const dir = await tempDir('taskpilot-log-');
  const file = path.join(dir, 'taskpilot.log');
  await writeFile(file, 'earlier\n');
  const logger = createLogger({ sink: () => {} });
  await logger.initialize(dir);
  logger.info('later');
  await logger.flush();
  assert.match(await readFile(file, 'utf8'), /^earlier\n.*later/s);
  assert.deepEqual(await readdir(dir), ['taskpilot.log']);
});
