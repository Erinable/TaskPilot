import { onTestFinished, test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { JsonWriteQueue, writeFileAtomic } from '../../src/main/atomic_json_file.ts';

const tempDir = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'taskpilot-atomic-'));
  onTestFinished(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
};

test('concurrent writes land one at a time and the file ends as the last snapshot', async () => {
  const file = path.join(await tempDir(), 'nested', 'state.json');
  const queue = new JsonWriteQueue();
  let state = 0;
  const writes = Array.from({ length: 20 }, () => {
    state += 1;
    return queue.write(() => ({ file, value: { state } }));
  });
  await Promise.all(writes);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { state: 20 });
  assert.deepEqual(await fs.readdir(path.dirname(file)), ['state.json']);
});

test('a failed write rejects for its caller and the next write still lands', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'state.json');
  // A directory where the temp file goes makes the write fail.
  await fs.mkdir(`${file}.tmp`);
  const queue = new JsonWriteQueue();
  await assert.rejects(() => queue.write(() => ({ file, value: { attempt: 1 } })));
  await queue.flush();
  await fs.rmdir(`${file}.tmp`);
  await queue.write(() => ({ file, value: { attempt: 2 } }));
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { attempt: 2 });
});

test('a failed write leaves the previous file intact', async () => {
  const file = path.join(await tempDir(), 'state.json');
  await writeFileAtomic(file, 'before');
  await fs.mkdir(`${file}.tmp`);
  await assert.rejects(() => writeFileAtomic(file, 'after'));
  assert.equal(await fs.readFile(file, 'utf8'), 'before');
});

test('writeFileAtomic uses the temp path and mode it is given', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'secret.json');
  await writeFileAtomic(file, '{}', { tmp: path.join(dir, '.custom.tmp'), mode: 0o600 });
  assert.equal(await fs.readFile(file, 'utf8'), '{}');
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(await fs.readdir(dir), ['secret.json']);
});
