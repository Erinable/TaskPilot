// IPC channels of the notes domain (src/main/ipc/notes.ts).
import { test, onTestFinished, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

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

  assert.equal((await h.call(CHANNELS.notesDelete, note.id)).data, true);
  assert.equal((await h.call(CHANNELS.notesDelete, note.id)).error.code, 'unknown_note');
  assert.deepEqual((await h.call(CHANNELS.notesList, null)).data.notes, []);
});

test('notes: the packs that name categories are the built-in ones and the confirmed one in use', async () => {
  const h = await fixtures.harness();
  assert.deepEqual((await h.call(CHANNELS.notesCourses)).data, {
    current: 'programming',
    packs: [
      {
        id: 'programming',
        title: '编程',
        rubric: [
          { id: 'thinking', label: '思路', dimension: 'thinking' },
          { id: 'writing', label: '写法', dimension: 'writing' },
          { id: 'style', label: '风格', dimension: 'style' },
        ],
      },
    ],
  });
  await fixtures.useOsPack(h, { confirm: false });
  assert.equal((await h.call(CHANNELS.notesCourses)).data.current, 'programming', 'an unconfirmed pack is not in use');
  await fixtures.useOsPack(h);
  const confirmed = (await h.call(CHANNELS.notesCourses)).data;
  assert.equal(confirmed.current, 'os');
  assert.deepEqual(
    confirmed.packs.map((pack) => [pack.id, pack.rubric.map((item) => `${item.id}:${item.dimension}`)]),
    [
      ['programming', ['thinking:thinking', 'writing:writing', 'style:style']],
      ['os', ['concept:thinking', 'mechanism:writing']],
    ],
  );
});

test('notes: another folder can only be one picked in the dialog', async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), 'tp-vault-'));
  onTestFinished(() => fs.rm(vault, { recursive: true, force: true }));
  const h = await fixtures.harness({ coding: { pickDirectory: async () => vault } });
  assert.equal((await h.call(CHANNELS.notesSetDirectory, vault)).error.code, 'invalid_argument');
  assert.equal((await h.call(CHANNELS.notesPickDirectory)).data, vault);
  assert.equal((await h.call(CHANNELS.notesSetDirectory, '/etc')).error.code, 'invalid_argument');
  const moved = await h.call(CHANNELS.notesSetDirectory, vault);
  assert.equal(moved.data.directory, vault);
  assert.equal((await h.call(CHANNELS.notesSetDirectory, null)).data.custom, false);
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
