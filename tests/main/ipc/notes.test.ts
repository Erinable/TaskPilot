/** @module-tag integration */
// IPC channels of the notes domain (src/main/ipc/notes.ts).
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { CHANNELS } from '../../../src/shared/ipc_channels.ts';
import * as fixtures from './harness.ts';
import { tempDir } from '../../fixtures/temp_dir.ts';
import { until } from '../../fixtures/until.ts';

// ========== notes ==========

test('notes: the channels create, edit and delete notes, which stay with the developer across repositories', async () => {
  const h = await fixtures.harness();
  const created = await h.call(CHANNELS.notesCreate, {
    title: '先写失败的测试',
    body: '先红后绿',
    category: 'thinking',
    tags: ['tdd'],
    source: { repositoryId: 'r', repositoryName: 'app', packageId: 'p', packageTitle: '登录', file: 'src/a.ts', line: 2 },
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal((await h.call(CHANNELS.notesCreate, { title: '' })).error.code, 'invalid_note');
  const note = created.data.note;
  const edited = await h.call(CHANNELS.notesUpdate, note.id, { title: '先写失败的测试', body: '', category: null, tags: [], baseVersion: note.version });
  assert.equal(edited.data.note.source.file, 'src/a.ts');
  assert.equal(
    (await h.call(CHANNELS.notesUpdate, note.id, { title: 'x', body: '', category: null, tags: [], baseVersion: note.version })).error.code,
    'note_conflict',
  );

  const other = await fixtures.gitRepo();
  const added = await h.call(CHANNELS.repositoriesAdd, other, true);
  assert.equal(added.ok, true);
  const list = (await h.call(CHANNELS.notesList, null)).data;
  assert.deepEqual(
    list.notes.map((entry) => entry.title),
    ['先写失败的测试'],
  );
  assert.equal(list.notes[0].body, undefined, 'the list carries no bodies');
  assert.equal((await h.call(CHANNELS.notesList, list.revision)).data, null, 'nothing changed since that revision');
  assert.equal((await h.call(CHANNELS.notesGet, note.id)).data.body, '');

  assert.equal((await h.call(CHANNELS.notesRemove, note.id)).data, true);
  assert.equal((await h.call(CHANNELS.notesRemove, note.id)).error.code, 'unknown_note');
  assert.deepEqual((await h.call(CHANNELS.notesList, null)).data.notes, []);
});

test('notes: Tutor writes a summary pinned to the version it read', async () => {
  const h = await fixtures.harness({ agent: async () => ({ output: { noteSummary: '先写失败的测试，再写实现。' }, costUsd: 0.01 }) });
  const { note } = (await h.call(CHANNELS.notesCreate, { title: '测试先行', body: '先红后绿', category: null, tags: [], source: null })).data;
  const saved = await h.call(CHANNELS.notesSummarize, note.id, note.version);
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.equal(saved.data.note.summary, '先写失败的测试，再写实现。');
  assert.match(h.agentCalls.at(-1)!.prompt, /<note>\nTitle: 测试先行\n\n先红后绿\n<\/note>/);
  assert.equal((await h.call(CHANNELS.notesSummarize, note.id, note.version)).error.code, 'note_conflict');
});

// Identical filenames and bytes deliberately also have the same content version.
test.each([false, true])('notes: an in-flight summary cannot write after a folder switch (switch back: %s)', async (switchBack) => {
  const held = Promise.withResolvers<unknown>();
  const other = await tempDir('tp-summary-vault-');
  const h = await fixtures.harness({ agent: async () => held.promise, coding: { pickDirectory: async () => other } });
  const { note } = (await h.call(CHANNELS.notesCreate, { title: 'Shared', body: 'same copied body', category: null, tags: [], source: null })).data;
  const original = path.join(h.notes.directory, note.id);
  const copied = path.join(other, note.id);
  const before = await fs.readFile(original, 'utf8');
  await fs.writeFile(copied, before);
  const inFlight = h.call(CHANNELS.notesSummarize, note.id, note.version);
  await until(
    () => h.agentCalls.length,
    (count) => count === 1,
    'summary started',
  );
  assert.equal((await h.call(CHANNELS.notesPickDirectory)).data, other);
  assert.equal((await h.call(CHANNELS.notesSetDirectory, other)).ok, true);
  if (switchBack) assert.equal((await h.call(CHANNELS.notesSetDirectory, null)).ok, true);
  held.resolve({ output: { noteSummary: 'old vault summary' }, costUsd: 0 });
  const result = await inFlight;
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'note_conflict');
  assert.equal(await fs.readFile(original, 'utf8'), before);
  assert.equal(await fs.readFile(copied, 'utf8'), before);
});
