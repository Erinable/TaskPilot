// @vitest-environment happy-dom
// The notes store's own stale-answer guards: a newer search, note or
// course load wins over an older one still in flight, and leaving drops a
// note that arrives afterwards.
import { beforeEach, expect, test, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { reactive } from 'vue';

import { useNotesStore } from '@/stores/notes.ts';
import { useRepositoryIdentityStore } from '@/stores/repository_identity.ts';
import { fail, installFakeApi, ok } from '../ipc_fakes.ts';
import { noteMeta } from '../notes_fakes.ts';
import type { IpcResult } from '@shared/ipc/envelope.ts';
import type * as noteTypes from '@shared/ipc/notes.ts';

vi.mock('@/lib/feedback.ts', () => ({ showToast: vi.fn(), confirmAction: vi.fn(async () => true) }));

const ALPHA = noteMeta({ id: 'alpha.md', title: 'alpha', tags: [], excerpt: '', source: null });
const BETA = noteMeta({ id: 'beta.md', title: 'beta', tags: [], excerpt: '', source: null });
const list: noteTypes.NoteList = { revision: 1, directory: '/notes', custom: false, unavailable: null, truncated: false, notes: [ALPHA, BETA] };
const noteOf = (meta: noteTypes.NoteMeta): noteTypes.Note => ({ ...meta, body: `${meta.title} body` });
const coursesFor = (current: string): noteTypes.NoteCourses => ({ current, packs: [] });

let api: ReturnType<typeof installFakeApi>;

beforeEach(() => {
  setActivePinia(createPinia());
  api = installFakeApi({
    notes: { list: () => ok(list), get: (id) => ok(noteOf(id === BETA.id ? BETA : ALPHA)), search: () => ok([]), courses: () => ok(coursesFor('programming')) },
  });
});

test('creating a note detaches nested reactive tags, concepts and source before IPC', async () => {
  const store = useNotesStore();
  const input: noteTypes.NoteInput = {
    title: 'created',
    body: '内容'.repeat(10000),
    category: 'writing',
    course: 'programming',
    tags: reactive(['review']),
    concepts: reactive(['testing']),
    source: reactive({ repositoryId: 'r1', repositoryName: 'repo', packageId: 'p1', packageTitle: 'task', file: 'src/a.ts', line: 4 }),
  };
  api.notes.create.mockReturnValueOnce(ok({ revision: 2, note: noteOf(ALPHA), relinked: 0 }));
  await store.create(reactive(input));
  const sent = api.notes.create.mock.calls[0][0];
  expect(structuredClone(sent)).toEqual(input);
  input.tags.push('later');
  input.concepts!.push('later');
  input.source!.line = 8;
  expect(sent.tags).toEqual(['review']);
  expect(sent.concepts).toEqual(['testing']);
  expect(sent.source?.line).toBe(4);
});

test('saving a note keeps dirty tracking and sends detached edit data', async () => {
  const store = useNotesStore();
  await store.openNote(ALPHA.id);
  expect(store.dirty).toBe(false);
  const tags = reactive(['edited']);
  store.draft!.tags = tags;
  store.draft!.body = '修改后的正文'.repeat(10000);
  expect(store.dirty).toBe(true);
  api.notes.update.mockReturnValueOnce(ok({ revision: 2, note: noteOf(ALPHA), relinked: 0 }));
  await store.save();
  const sent = api.notes.update.mock.calls[0][1];
  expect(structuredClone(sent)).toMatchObject({ body: '修改后的正文'.repeat(10000), tags: ['edited'], baseVersion: ALPHA.version });
  tags.push('later');
  expect(sent.tags).toEqual(['edited']);
  expect(store.dirty).toBe(false);
  store.draft!.body += '再修改';
  expect(store.dirty).toBe(true);
});

test('a save advances the base version without discarding input made after submission', async () => {
  const store = useNotesStore();
  await store.load();
  await store.goNote(ALPHA.id);
  store.startEditing();
  store.draft!.body = 'submitted';
  const held = Promise.withResolvers<IpcResult<noteTypes.NoteSaved>>();
  api.notes.update.mockReturnValueOnce(held.promise);
  const saving = store.save();
  store.draft!.body = 'submitted plus later input';
  store.draft!.tags.push('later');
  held.resolve({ ok: true, data: { revision: 2, relinked: 0, note: { ...noteOf(ALPHA), body: 'submitted', version: 'v2' } } });
  await saving;
  expect(store.current).toMatchObject({ id: ALPHA.id, body: 'submitted', version: 'v2' });
  expect(store.notes.find((note) => note.id === ALPHA.id)?.version).toBe('v2');
  expect(store.draft).toMatchObject({ body: 'submitted plus later input', tags: ['later'] });
  expect(store.dirty).toBe(true);
  api.notes.update.mockReturnValueOnce(ok({ revision: 3, relinked: 0, note: { ...store.current!, ...store.draft!, version: 'v3' } }));
  await store.save();
  expect(api.notes.update).toHaveBeenLastCalledWith(ALPHA.id, expect.objectContaining({ baseVersion: 'v2', body: 'submitted plus later input', force: false }));
  expect(store.dirty).toBe(false);
});

test('a renamed save updates its list and history while leaving a different note and draft alone', async () => {
  const store = useNotesStore();
  await store.load();
  await store.goNote(ALPHA.id);
  store.draft!.title = 'renamed';
  const held = Promise.withResolvers<IpcResult<noteTypes.NoteSaved>>();
  api.notes.update.mockReturnValueOnce(held.promise);
  const saving = store.save({ force: true, renameLinks: true });
  await store.goNote(BETA.id);
  store.startEditing();
  store.draft!.body = 'beta unsaved';
  held.resolve({ ok: true, data: { revision: 2, relinked: 1, note: { ...noteOf(ALPHA), id: 'renamed.md', title: 'renamed', version: 'v2' } } });
  await saving;
  expect(api.notes.update).toHaveBeenCalledWith(ALPHA.id, expect.objectContaining({ title: 'renamed', baseVersion: 'v1', force: true, renameLinks: true }));
  expect(store.notes.map((note) => note.id)).toEqual(['renamed.md', BETA.id]);
  expect(store.route).toMatchObject({ name: 'note', id: BETA.id });
  expect(store.current?.id).toBe(BETA.id);
  expect(store.draft?.body).toBe('beta unsaved');
  expect(store.editing).toBe(true);
  expect(store.dirty).toBe(true);
  api.notes.get.mockReturnValueOnce(ok({ ...noteOf(ALPHA), id: 'renamed.md', title: 'renamed' }));
  await store.goBack();
  expect(store.route).toMatchObject({ name: 'note', id: 'renamed.md' });
});

test('a save cannot replace a reopened note with the same id', async () => {
  const store = useNotesStore();
  await store.goNote(ALPHA.id);
  store.draft!.body = 'submitted';
  const held = Promise.withResolvers<IpcResult<noteTypes.NoteSaved>>();
  api.notes.update.mockReturnValueOnce(held.promise);
  const saving = store.save();
  await store.goIndex();
  await store.goNote(ALPHA.id);
  store.draft!.body = 'new editing session';
  held.resolve({ ok: true, data: { revision: 2, relinked: 0, note: { ...noteOf(ALPHA), body: 'submitted', version: 'v2' } } });
  await saving;
  expect(store.current?.body).toBe('alpha body');
  expect(store.draft?.body).toBe('new editing session');
  expect(store.dirty).toBe(true);
  expect(store.notes.find((note) => note.id === ALPHA.id)?.version).toBe('v2');
});

test('a conflict from a previous note does not mark the current note conflicting', async () => {
  const store = useNotesStore();
  await store.goNote(ALPHA.id);
  const held = Promise.withResolvers<IpcResult<noteTypes.NoteSaved>>();
  api.notes.update.mockReturnValueOnce(held.promise);
  const saving = store.save();
  await store.goNote(BETA.id);
  held.resolve({ ok: false, error: { code: 'note_conflict', message: 'changed' } });
  expect(await saving).toBeNull();
  expect(store.current?.id).toBe(BETA.id);
  expect(store.conflict).toBe(false);
});

test('a save from a previous notes folder cannot add its result to the new folder', async () => {
  const store = useNotesStore();
  await store.load();
  await store.goNote(ALPHA.id);
  const held = Promise.withResolvers<IpcResult<noteTypes.NoteSaved>>();
  api.notes.update.mockReturnValueOnce(held.promise);
  const saving = store.save();
  api.notes.setDirectory.mockReturnValueOnce(ok({ ...list, directory: '/new-notes', notes: [] }));
  await store.resetDirectory();
  held.resolve({ ok: true, data: { revision: 2, relinked: 0, note: { ...noteOf(ALPHA), version: 'v2' } } });
  await saving;
  expect(store.notes).toEqual([]);
  expect(store.current).toBeNull();
  expect(store.route.name).toBe('index');
});

test('a rename keeps later title edits while the next save addresses the renamed file', async () => {
  const store = useNotesStore();
  await store.goNote(ALPHA.id);
  store.draft!.title = 'renamed';
  const held = Promise.withResolvers<IpcResult<noteTypes.NoteSaved>>();
  api.notes.update.mockReturnValueOnce(held.promise);
  const saving = store.save({ renameLinks: true });
  store.draft!.title = 'another rename';
  store.draft!.body = 'later body';
  held.resolve({ ok: true, data: { revision: 2, relinked: 1, note: { ...noteOf(ALPHA), id: 'renamed.md', title: 'renamed', version: 'v2' } } });
  await saving;
  expect(store.route).toMatchObject({ id: 'renamed.md' });
  expect(store.current?.id).toBe('renamed.md');
  expect(store.draft).toMatchObject({ title: 'another rename', body: 'later body' });
  expect(store.dirty).toBe(true);
  api.notes.update.mockReturnValueOnce(ok({ revision: 3, relinked: 0, note: { ...store.current!, ...store.draft!, id: 'another rename.md', version: 'v3' } }));
  await store.save();
  expect(api.notes.update).toHaveBeenLastCalledWith('renamed.md', expect.objectContaining({ title: 'another rename', baseVersion: 'v2' }));
  expect(store.dirty).toBe(false);
});

test('summarizing after saving does not continue onto another note or newer unsaved input', async () => {
  const store = useNotesStore();
  await store.goNote(ALPHA.id);
  store.draft!.body = 'submitted';
  const held = Promise.withResolvers<IpcResult<noteTypes.NoteSaved>>();
  api.notes.update.mockReturnValueOnce(held.promise);
  const summarizing = store.summarize();
  store.draft!.body = 'later input';
  held.resolve({ ok: true, data: { revision: 2, relinked: 0, note: { ...noteOf(ALPHA), body: 'submitted', version: 'v2' } } });
  await summarizing;
  expect(api.notes.summarize).not.toHaveBeenCalled();
  expect(store.draft?.body).toBe('later input');
  expect(store.dirty).toBe(true);
});

test('a summary response updates only its own note and preserves later summary edits', async () => {
  const store = useNotesStore();
  await store.load();
  await store.goNote(ALPHA.id);
  const first = Promise.withResolvers<IpcResult<noteTypes.NoteSaved>>();
  api.notes.summarize.mockReturnValueOnce(first.promise);
  const summarizing = store.summarize();
  store.draft!.summary = 'my later summary';
  first.resolve({ ok: true, data: { revision: 2, relinked: 0, note: { ...noteOf(ALPHA), summary: 'generated', version: 'v2' } } });
  await summarizing;
  expect(store.current?.summary).toBe('generated');
  expect(store.draft?.summary).toBe('my later summary');
  await store.goNote(BETA.id);
  const second = Promise.withResolvers<IpcResult<noteTypes.NoteSaved>>();
  api.notes.summarize.mockReturnValueOnce(second.promise);
  const other = store.summarize();
  await store.goNote(ALPHA.id);
  store.draft!.body = 'alpha unsaved';
  second.resolve({ ok: true, data: { revision: 3, relinked: 0, note: { ...noteOf(BETA), summary: 'beta summary', version: 'v3' } } });
  await other;
  expect(store.current?.id).toBe(ALPHA.id);
  expect(store.draft?.body).toBe('alpha unsaved');
  expect(store.notes.find((note) => note.id === BETA.id)?.version).toBe('v3');
});

test('an older body search that answers last does not filter the list', async () => {
  const store = useNotesStore();
  await store.load();
  const older = Promise.withResolvers<IpcResult<string[]>>();
  api.notes.search.mockReturnValueOnce(older.promise).mockReturnValueOnce(ok([BETA.id]));
  store.filter.query = 'zzz';
  const first = store.search('zzz');
  await store.search('zzz');
  older.resolve({ ok: true, data: [ALPHA.id] });
  await first;
  expect(store.visible.map((note) => note.id)).toEqual([BETA.id]);
});

test('opening another note while one loads shows the one opened last', async () => {
  const store = useNotesStore();
  const older = Promise.withResolvers<IpcResult<noteTypes.Note>>();
  api.notes.get.mockReturnValueOnce(older.promise);
  const first = store.openNote(ALPHA.id);
  await store.openNote(BETA.id);
  older.resolve({ ok: true, data: noteOf(ALPHA) });
  await first;
  expect(store.current?.id).toBe(BETA.id);
  expect(store.draft?.body).toBe('beta body');
});

test('a note that arrives after leaving the notes page is dropped', async () => {
  const store = useNotesStore();
  store.startWatching();
  const held = Promise.withResolvers<IpcResult<noteTypes.Note>>();
  api.notes.get.mockReturnValueOnce(held.promise);
  const opening = store.openNote(ALPHA.id);
  store.stopWatching();
  held.resolve({ ok: true, data: noteOf(ALPHA) });
  await opening;
  expect(store.current).toBeNull();
});

test('course filters loaded for a repository that is no longer open are dropped', async () => {
  const repositories = useRepositoryIdentityStore();
  repositories.currentId = 'a';
  const store = useNotesStore();
  const held = Promise.withResolvers<IpcResult<noteTypes.NoteCourses>>();
  api.notes.courses.mockReturnValueOnce(held.promise);
  const loading = store.loadCourses();
  repositories.currentId = 'b';
  held.resolve({ ok: true, data: coursesFor('os') });
  await loading;
  expect(store.courses.current).not.toBe('os');
});

test('typing does not refilter the list until the debounced search for that query answers', async () => {
  const store = useNotesStore();
  await store.load();
  store.filter.query = 'beta';
  expect(store.visible.map((note) => note.id)).toEqual([ALPHA.id, BETA.id]);
  await store.search('beta');
  expect(store.visible.map((note) => note.id)).toEqual([BETA.id]);
  store.filter.query = '';
  await store.search('');
  expect(store.visible).toHaveLength(2);
});

test('a failed body search still filters by title', async () => {
  const store = useNotesStore();
  await store.load();
  api.notes.search.mockImplementationOnce(() => fail('unknown', 'disk gone'));
  store.filter.query = 'alpha';
  await expect(store.search('alpha')).rejects.toThrow('disk gone');
  expect(store.visible.map((note) => note.id)).toEqual([ALPHA.id]);
});
