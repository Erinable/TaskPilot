// IPC channels of the notes domain (src/main/ipc/notes.ts).
import { test, vi } from 'vitest';
import assert from 'node:assert/strict';

import { CHANNELS } from '../../../src/shared/ipc_channels.ts';
import * as fixtures from './harness.ts';

// Runs real git and npm processes per test; slow machines and CI need the room.
vi.setConfig({ testTimeout: 20_000 });

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
