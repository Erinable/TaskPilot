import { onTestFinished, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { MAX_NOTES, NOTES_FILENAME, NoteStore, validateNote } from '../../src/main/note_store.ts';

const dir = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tp-notes-'));
  onTestFinished(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
};
const input = (overrides = {}) => ({
  title: '先写失败的测试',
  body: '先红后绿。\n\t再重构。',
  category: 'thinking',
  tags: ['测试', '测试', 'tdd'],
  source: null,
  ...overrides,
});

test('notes are saved, listed newest first, and survive a reload', async () => {
  const configDir = await dir();
  let now = Date.parse('2026-10-24T00:00:00Z');
  const store = await new NoteStore(configDir, { now: () => new Date((now += 1000)) }).load();
  const first = await store.create(input());
  const second = await store.create(input({ title: '变量写全名', category: 'style' }));
  assert.deepEqual(first.tags, ['测试', 'tdd'], 'tags are deduplicated');
  assert.equal(first.body, '先红后绿。\n\t再重构。', 'newlines and tabs are kept');
  assert.deepEqual(
    store.list().map((note) => note.id),
    [second.id, first.id],
  );

  await store.update(first.id, { title: '先写失败的测试（改）', body: '', category: null, tags: [] });
  assert.equal(store.list()[0].id, first.id, 'an edit moves the note to the top');
  const reloaded = await new NoteStore(configDir).load();
  assert.equal(reloaded.get(first.id).title, '先写失败的测试（改）');
  assert.equal(reloaded.get(first.id).category, null);
});

test('an edit keeps the recorded source whatever the renderer sends', async () => {
  const store = await new NoteStore(await dir()).load();
  const source = { repositoryId: 'r', repositoryName: 'app', packageId: 'p', packageTitle: '登录', file: 'src/a.ts', line: 3 };
  const note = await store.create(input({ source }));
  const edited = await store.update(note.id, { ...input(), source: { ...source, file: '../../etc/passwd' } });
  assert.deepEqual(edited.source, source);
});

test('bad input is refused field by field', () => {
  for (const [bad, field] of [
    [input({ title: ' ' }), 'title'],
    [input({ title: 'x'.repeat(81) }), 'title'],
    [input({ body: 'a‮b' }), 'body'],
    [input({ category: 'mood' }), 'category'],
    [input({ tags: Array(9).fill('t') }), 'tags'],
    [input({ source: { line: 0 } }), 'source.line'],
    [input({ source: 'x' }), 'source'],
  ] as const)
    assert.throws(() => validateNote(bad), { code: 'invalid_note', field }, field);
});

test('a full notebook refuses new notes and deletes nothing', async () => {
  const configDir = await dir();
  const saved = Array.from({ length: MAX_NOTES }, (_unused, index) => ({ id: `n${index}`, ...input(), createdAt: '', updatedAt: `${index}` }));
  await fs.writeFile(path.join(configDir, NOTES_FILENAME), JSON.stringify(saved));
  const store = await new NoteStore(configDir).load();
  await assert.rejects(() => store.create(input()), { code: 'notes_full' });
  assert.equal(store.list().length, MAX_NOTES);
  await store.remove('n0');
  await store.create(input());
  assert.equal(store.list().length, MAX_NOTES);
  await assert.rejects(() => store.remove('n0'), { code: 'unknown_note' });
});

test('an unreadable notes file is kept aside, not overwritten', async () => {
  const configDir = await dir();
  await fs.writeFile(path.join(configDir, NOTES_FILENAME), '{oops');
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  onTestFinished(() => errors.mockRestore());
  const store = await new NoteStore(configDir, { now: () => new Date(42) }).load();
  assert.deepEqual(store.list(), []);
  assert.equal(await fs.readFile(path.join(configDir, `${NOTES_FILENAME}.corrupt-42`), 'utf8'), '{oops');
});
