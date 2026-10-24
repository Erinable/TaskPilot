import { describe, expect, test } from 'vitest';

import { filterNotes, sourceLabel } from '../../src/renderer/src/lib/notes_model.ts';
import type * as ipc from '../../src/shared/ipc_types.ts';

const note = (id: string, overrides: Partial<ipc.Note> = {}): ipc.Note => ({
  id,
  title: id,
  body: '',
  category: null,
  tags: [],
  source: null,
  createdAt: '',
  updatedAt: '',
  ...overrides,
});

describe('notes model', () => {
  const notes = [
    note('a', { title: '先写测试', category: 'thinking', tags: ['tdd'] }),
    note('b', { body: 'Use FULL names', category: 'style' }),
    note('c', { source: { repositoryId: null, repositoryName: 'api', packageId: null, packageTitle: '登录', file: 'src/login.ts', line: null } }),
  ];
  const ids = (list: ipc.Note[]) => list.map((entry) => entry.id);

  test('filters by category, tag and a case-insensitive search over text, tags and source', () => {
    expect(ids(filterNotes(notes, { query: '', category: 'style', tag: null }))).toEqual(['b']);
    expect(ids(filterNotes(notes, { query: '', category: null, tag: 'tdd' }))).toEqual(['a']);
    expect(ids(filterNotes(notes, { query: 'full', category: null, tag: null }))).toEqual(['b']);
    expect(ids(filterNotes(notes, { query: ' login.ts ', category: null, tag: null }))).toEqual(['c']);
    expect(ids(filterNotes(notes, { query: '', category: null, tag: null }))).toEqual(['a', 'b', 'c']);
  });

  test('the source label leaves out what is unknown', () => {
    expect(sourceLabel(null)).toBeNull();
    expect(sourceLabel(notes[2].source)).toBe('api · 登录 · src/login.ts');
    expect(sourceLabel({ repositoryId: null, repositoryName: null, packageId: null, packageTitle: null, file: 'a.ts', line: 3 })).toBe('a.ts:3');
  });
});
