// @vitest-environment happy-dom
// The notes store's own stale-answer guards: a newer search, note or
// course load wins over an older one still in flight, and leaving drops a
// note that arrives afterwards.
import { beforeEach, expect, test } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

import { useNotesStore } from '@/stores/notes.ts';
import { useRepositoryIdentityStore } from '@/stores/repository_identity.ts';
import { installFakeApi, ok } from '../ipc_fakes.ts';
import { noteMeta } from '../notes_fakes.ts';
import type { IpcResult } from '@shared/ipc/envelope.ts';
import type * as noteTypes from '@shared/ipc/notes.ts';

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
