import { describe, expect, test } from 'vitest';

import * as model from '../../src/renderer/src/lib/notes_model.ts';
import * as markdown from '../../src/shared/note_markdown.ts';
import type * as noteTypes from '../../src/shared/ipc/notes.ts';

const note = (id: string, overrides: Partial<noteTypes.NoteMeta> = {}): noteTypes.NoteMeta => ({
  id,
  title: id,
  category: null,
  tags: [],
  inlineTags: [],
  source: null,
  summary: null,
  summaryStale: false,
  links: [],
  excerpt: '',
  createdAt: '',
  updatedAt: '',
  version: 'v',
  frontmatterError: false,
  ...overrides,
});

describe('notes model', () => {
  const notes = [
    note('a', { title: '先写测试', category: 'thinking', tags: ['tdd'] }),
    note('b', { excerpt: 'Use FULL names', category: 'style', inlineTags: ['命名'] }),
    note('c', { source: { repositoryId: null, repositoryName: 'api', packageId: null, packageTitle: '登录', file: 'src/login.ts', line: null } }),
  ];
  const ids = (list: noteTypes.NoteMeta[]) => list.map((entry) => entry.id);
  const all = { query: '', category: null, tag: null };

  test('filters by category, frontmatter or body tags, and a search over text, tags, source and body matches', () => {
    expect(ids(model.filterNotes(notes, { ...all, category: 'style' }))).toEqual(['b']);
    expect(ids(model.filterNotes(notes, { ...all, tag: 'tdd' }))).toEqual(['a']);
    expect(ids(model.filterNotes(notes, { ...all, tag: '命名' }))).toEqual(['b']);
    expect(ids(model.filterNotes(notes, { ...all, query: 'full' }))).toEqual(['b']);
    expect(ids(model.filterNotes(notes, { ...all, query: ' login.ts ' }))).toEqual(['c']);
    expect(ids(model.filterNotes(notes, { ...all, query: '只在正文里' }, new Set(['a'])))).toEqual(['a']);
    expect(ids(model.filterNotes(notes, all))).toEqual(['a', 'b', 'c']);
  });

  test('the source label leaves out what is unknown', () => {
    expect(model.sourceLabel(null)).toBeNull();
    expect(model.sourceLabel(notes[2].source)).toBe('api · 登录 · src/login.ts');
    expect(model.sourceLabel({ repositoryId: null, repositoryName: null, packageId: null, packageTitle: null, file: 'a.ts', line: 3 })).toBe('a.ts:3');
  });

  test('backlinks and rename counts match titles in any case', () => {
    const target = note('命名.md', { title: 'Naming' });
    const list = [target, note('x', { links: ['naming'] }), note('y', { links: ['other'] }), note('z', { links: ['NAMING'] })];
    expect(ids(model.backlinks(list, target))).toEqual(['x', 'z']);
    expect(model.linkingCount(list, 'Naming', target.id)).toBe(2);
  });

  test('[[ completion finds the open link and finishes it', () => {
    expect(model.linkQueryAt('见 [[变量', 6)).toEqual({ start: 2, query: '变量' });
    expect(model.linkQueryAt('见 [[变量]] 后', 10)).toBeNull();
    expect(model.linkQueryAt('[[a\nb', 5)).toBeNull();
    const list = [note('1', { title: '命名变量' }), note('2', { title: '变量命名' }), note('3', { title: '无关' })];
    expect(model.linkSuggestions(list, '变量', null).map((entry) => entry.title)).toEqual(['变量命名', '命名变量']);
    expect(model.completeLink('见 [[变', 2, 5, '变量命名')).toEqual({ text: '见 [[变量命名]]', cursor: 10 });
    expect(model.completeLink('见 [[变]] 后', 2, 5, '变量命名')).toEqual({ text: '见 [[变量命名]] 后', cursor: 10 });
  });
});

test('the archive groups by the business-day month written, newest first, and counts tags and categories', () => {
  const list = [
    note('c', { createdAt: '2026-09-29T10:00:00Z', category: 'style' }),
    note('a', { createdAt: '2026-10-24T02:00:00Z', category: 'style', tags: ['x'], inlineTags: ['y'] }),
    note('b', { createdAt: '2026-09-30T17:00:00Z', tags: ['x'] }),
  ];
  expect(model.groupByMonth(list, 'Asia/Shanghai').map((group) => [group.label, group.notes.map((entry) => entry.id)])).toEqual([
    ['2026 年 10 月', ['a', 'b']],
    ['2026 年 9 月', ['c']],
  ]);
  expect(model.tagCounts([list[1], list[2]])).toEqual([
    { tag: 'x', count: 2 },
    { tag: 'y', count: 1 },
  ]);
  expect(model.categoryCounts(list)).toEqual({ style: 2 });
  expect(model.formatDay('2026-09-30T17:00:00Z', 'Asia/Shanghai')).toBe('2026-10-01');
});

describe('note markdown', () => {
  test('titles must work as file names and inside [[links]]', () => {
    expect(markdown.titleProblem('变量命名')).toBeNull();
    for (const bad of ['', ' a', 'a/b', 'a:b', 'a#b', 'a|b', '[a]', '.hidden', 'x'.repeat(81)]) expect(markdown.titleProblem(bad), bad).not.toBeNull();
    expect(markdown.toTitle('  a/b: c#d  ')).toBe('a b c d');
    expect(markdown.toTitle('...')).toBe('未命名');
  });

  test('renaming links keeps headings, aliases and code untouched', () => {
    const body = '[[Old]] [[old#节|别名]] `[[Old]]` [[Older]]';
    expect(markdown.renameLinks(body, 'old', 'New')).toBe('[[New]] [[New#节|别名]] `[[Old]]` [[Older]]');
  });

  test('a body scan finds headings, links and tags outside code', () => {
    const scan = markdown.scanBody('# 一\n\n## 二 [[链]]\n\n#标签 `#不是` a#b #42\n');
    expect(scan.headings).toEqual([
      { depth: 1, text: '一', line: 1 },
      { depth: 2, text: '二 [[链]]', line: 3 },
    ]);
    expect(scan.links.map((link) => link.target)).toEqual(['链']);
    expect(scan.tags).toEqual(['标签']);
  });

  test('math is not searched for links or tags, nor shown in excerpts', () => {
    const body = '公式 $a_{#1}$ 和\n\n$$\n[[不是链接]] \\#x\n$$\n';
    const scan = markdown.scanBody(body);
    expect(scan.links).toEqual([]);
    expect(scan.tags).toEqual([]);
    expect(markdown.excerptOf(markdown.parseMarkdown(body))).toBe('公式 和');
    expect(markdown.excerptOf(markdown.parseMarkdown('# 逻辑回归\n\n正文'), '逻辑回归')).toBe('正文');
    expect(markdown.excerptOf(markdown.parseMarkdown('# 别的\n\n正文'), '逻辑回归')).toBe('别的 正文');
  });
});
