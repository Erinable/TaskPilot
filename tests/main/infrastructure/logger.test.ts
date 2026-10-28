import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFile, stat, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '../../../src/main/infrastructure/logger.ts';
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
});
