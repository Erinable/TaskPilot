import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { tempDir } from '../../fixtures/temp_dir.ts';
import { readStoredJson, writeStoredJson } from '../../../src/main/infrastructure/persisted_json.ts';
import { JsonWriteQueue } from '../../../src/main/infrastructure/atomic_json_file.ts';
import { WorkPackageStore, STATE_FILENAME } from '../../../src/main/work_packages/work_package_store.ts';
import { NoteStore, LOCATION_FILENAME } from '../../../src/main/notes/note_store.ts';
import * as preferences from '../../../src/main/app/preferences.ts';
import * as workspace from '../../../src/main/repository/workspace.ts';
import { ActivityLog, EVENTS_DIRNAME, businessDay } from '../../../src/main/activity/activity_log.ts';
import { writePrivate, readHints, labDir } from '../../../src/main/courses/labs.ts';

const directory = () => tempDir('taskpilot-storage-');

test('legacy v1 payloads remain readable and a current write roundtrips its data', async () => {
  const file = path.join(await directory(), 'state.json');
  await fs.writeFile(file, JSON.stringify([{ id: 'legacy' }]));
  assert.deepEqual(await readStoredJson(file), [{ id: 'legacy' }]);
  await writeStoredJson(file, { version: 1, items: [{ id: 'current' }] });
  assert.deepEqual(await readStoredJson(file), { version: 1, items: [{ id: 'current' }] });
});

test('a future or malformed explicit version cannot be read or replaced', async () => {
  const dir = await directory();
  for (const version of [2, '1', 0]) {
    const file = path.join(dir, 'future.json');
    const before = JSON.stringify({ version, payload: 'keep' });
    await fs.writeFile(file, before);
    await assert.rejects(readStoredJson(file), { code: 'unsupported_version' });
    await assert.rejects(writeStoredJson(file, { version: 1, payload: 'replace' }), { code: 'unsupported_version' });
    assert.equal(await fs.readFile(file, 'utf8'), before);
  }
});

test('guarded writes stay serialized and flush waits for the pending store commit', async () => {
  const file = path.join(await directory(), 'state.json');
  const queue = new JsonWriteQueue();
  const { promise, resolve } = Promise.withResolvers<void>();
  const first = queue.enqueue(async () => {
    await promise;
    await writeStoredJson(file, { version: 1, count: 1 });
  });
  const second = queue.enqueue(() => writeStoredJson(file, { version: 1, count: 2 }));
  let flushed = false;
  const flushing = queue.flush().then(() => {
    flushed = true;
  });
  await Promise.resolve();
  assert.equal(flushed, false);
  resolve();
  await Promise.all([first, second, flushing]);
  assert.deepEqual(await readStoredJson(file), { version: 1, count: 2 });
});

test('saving preferences or workspace without loading refuses a newer file', async () => {
  const dir = await directory();
  for (const [filename, version, save] of [
    [preferences.PREFERENCES_FILENAME, 2, () => preferences.save(dir, preferences.defaults())],
    [workspace.CONFIG_FILENAME, workspace.CONFIG_VERSION + 1, () => workspace.save(dir, workspace.emptyConfig())],
  ] as const) {
    const file = path.join(dir, filename);
    const before = JSON.stringify({ version, untouched: 'new application data' });
    await fs.writeFile(file, before);
    await assert.rejects(save(), { code: 'unsupported_version' });
    assert.equal(await fs.readFile(file, 'utf8'), before);
  }
});

test('resetting package progress or note location cannot delete a newer format', async () => {
  const dir = await directory();
  const state = path.join(dir, STATE_FILENAME);
  const location = path.join(dir, LOCATION_FILENAME);
  const before = JSON.stringify({ version: 2, untouched: 'keep' });
  await fs.writeFile(state, before);
  await fs.writeFile(location, before);
  await assert.rejects(new WorkPackageStore(dir).reset(), { code: 'unsupported_version' });
  const notes = new NoteStore(dir, { watch: false });
  try {
    await assert.rejects(notes.setDirectory(null), { code: 'unsupported_version' });
  } finally {
    notes.close();
  }
  assert.equal(await fs.readFile(state, 'utf8'), before);
  assert.equal(await fs.readFile(location, 'utf8'), before);
});

test('future JSONL events refuse append and prune without changing the log', async () => {
  const dir = await directory();
  const now = new Date('2026-10-28T12:00:00Z');
  const eventDir = path.join(dir, EVENTS_DIRNAME);
  await fs.mkdir(eventDir);
  const today = path.join(eventDir, `${businessDay(now, 'UTC')}.jsonl`);
  const old = path.join(eventDir, '2026-01-01.jsonl');
  const event = JSON.stringify({ storageVersion: 2, kind: 'requirement_created', requirementId: 'req', title: 'keep', at: now.toISOString() }) + '\n';
  await fs.writeFile(today, event);
  await fs.writeFile(old, event);
  const activity = new ActivityLog(dir, { timeZone: 'UTC', now: () => now });
  await assert.rejects(activity.append({ kind: 'requirement_created', requirementId: 'next', title: 'must not append' }), { code: 'unsupported_version' });
  await assert.rejects(activity.prune(), { code: 'unsupported_version' });
  assert.equal(await fs.readFile(today, 'utf8'), event);
  assert.equal(await fs.readFile(old, 'utf8'), event);
});

test('future private lab manifests refuse reads and replacement before deleting private files', async () => {
  const dir = await directory();
  const privateDir = labDir(dir, 'one');
  await fs.mkdir(privateDir, { recursive: true });
  const file = path.join(privateDir, 'hints.json');
  const before = JSON.stringify({ version: 2, hints: [] });
  await fs.writeFile(file, before);
  await fs.writeFile(path.join(privateDir, 'reference.patch'), 'private original');
  await assert.rejects(readHints(dir, 'one'), { code: 'unsupported_version' });
  await assert.rejects(writePrivate(dir, 'one', { reference: 'replacement', hidden: {}, hints: [], verify: null }), { code: 'unsupported_version' });
  assert.equal(await fs.readFile(file, 'utf8'), before);
  assert.equal(await fs.readFile(path.join(privateDir, 'reference.patch'), 'utf8'), 'private original');
});
