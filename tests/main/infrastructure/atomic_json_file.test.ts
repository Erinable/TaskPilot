import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { tempDir } from '../../fixtures/temp_dir.ts';
import { JsonWriteQueue, jsonText, writeFileAtomic } from '../../../src/main/infrastructure/atomic_json_file.ts';

test('concurrent writes land one at a time and the file ends as the last snapshot', async () => {
  const file = path.join(await tempDir('taskpilot-atomic-'), 'nested', 'state.json');
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
  const dir = await tempDir('taskpilot-atomic-');
  const file = path.join(dir, 'state.json');
  // A read-only folder makes the temp file write fail.
  await fs.chmod(dir, 0o500);
  const queue = new JsonWriteQueue();
  try {
    await assert.rejects(() => queue.write(() => ({ file, value: { attempt: 1 } })));
    await queue.flush();
  } finally {
    await fs.chmod(dir, 0o700);
  }
  await queue.write(() => ({ file, value: { attempt: 2 } }));
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { attempt: 2 });
});

test('a failed rename leaves the previous file intact and no temp file behind', async () => {
  const dir = await tempDir('taskpilot-atomic-');
  const file = path.join(dir, 'state.json');
  await writeFileAtomic(file, 'before');
  // A non-empty folder at the target makes the rename fail after the temp file is written.
  const blocked = path.join(dir, 'blocked');
  await fs.mkdir(path.join(blocked, 'child'), { recursive: true });
  await assert.rejects(() => writeFileAtomic(blocked, 'after'));
  assert.equal(await fs.readFile(file, 'utf8'), 'before');
  assert.deepEqual((await fs.readdir(dir)).sort(), ['blocked', 'state.json']);
});

// Stores outside a JsonWriteQueue (repositories, workspace, preferences,
// courses) can replace the same file at once; a shared temp name made one
// rename fail with ENOENT or land another writer's half-written content.
test('concurrent unqueued writes to the same file all land and leave one complete file', async () => {
  const dir = await tempDir('taskpilot-atomic-');
  const file = path.join(dir, 'state.json');
  const values = Array.from({ length: 20 }, (_unused, index) => jsonText({ index, padding: 'x'.repeat(10_000) }));
  await Promise.all(values.map((value) => writeFileAtomic(file, value)));
  assert.ok(values.includes(await fs.readFile(file, 'utf8')));
  assert.deepEqual(await fs.readdir(dir), ['state.json']);
});

test('writeFileAtomic uses the temp path and mode it is given', async () => {
  const dir = await tempDir('taskpilot-atomic-');
  const file = path.join(dir, 'secret.json');
  await writeFileAtomic(file, '{}', { tmp: path.join(dir, '.custom.tmp'), mode: 0o600 });
  assert.equal(await fs.readFile(file, 'utf8'), '{}');
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(await fs.readdir(dir), ['secret.json']);
});
