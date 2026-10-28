import { onTestFinished, test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { captureExpectedErrors } from '../../fixtures/expected_errors.ts';
import { tempDir } from '../../fixtures/temp_dir.ts';
import { until } from '../../fixtures/until.ts';
import { DEFAULT_DIRNAME, LOCATION_FILENAME, MAX_NOTES, NoteStore } from '../../../src/main/notes/note_store.ts';
import { validateNote } from '../../../src/main/notes/note_file.ts';

const dir = () => tempDir('tp-notes-');
const input = (overrides = {}) => ({
  title: '先写失败的测试',
  body: '先红后绿。\n\n```ts\nexpect(x).toBe(1)\n```\n',
  category: 'thinking',
  tags: ['测试', '#测试', 'tdd'],
  source: null,
  ...overrides,
});
const open = async (configDir: string, options = {}) => {
  const store = await new NoteStore(configDir, { watch: false, ...options }).load();
  onTestFinished(() => store.close());
  return store;
};
const notesDir = (configDir: string) => path.join(configDir, DEFAULT_DIRNAME);
const edit = (note: { version: string }, overrides = {}) => ({
  title: '先写失败的测试',
  body: 'b',
  category: null,
  tags: [],
  baseVersion: note.version,
  ...overrides,
});

test('a note is a Markdown file named by its title, its fields in the frontmatter', async () => {
  const configDir = await dir();
  const store = await open(configDir, { now: () => new Date('2026-10-24T00:00:00Z') });
  const { note } = await store.create(input());
  assert.equal(note.id, '先写失败的测试.md');
  assert.deepEqual(note.tags, ['测试', 'tdd'], 'tags are deduplicated and lose their #');
  const raw = await fs.readFile(path.join(notesDir(configDir), note.id), 'utf8');
  assert.equal(raw, '---\ncategory: thinking\ntags:\n  - 测试\n  - tdd\ncreated: 2026-10-24T00:00:00.000Z\n---\n先红后绿。\n\n```ts\nexpect(x).toBe(1)\n```\n');
  assert.equal((await open(configDir)).get(note.id).body, input().body, 'survives a reload');
  await assert.rejects(() => store.create(input()), { code: 'note_exists' });
  assert.equal((await store.create(input(), { autoRename: true })).note.title, '先写失败的测试 2');
});

test('links, #tags in the body and an excerpt are read from the Markdown, never from code', async () => {
  const store = await open(await dir());
  const body = '# 标题\n见 [[变量命名|命名]] 和 [[测试#断言]]，#习惯 #123\n\n`[[不是链接]] #不是`\n\n```\n[[也不是]]\n```\n';
  const { note } = await store.create(input({ body }));
  assert.deepEqual(note.links, ['变量命名', '测试']);
  assert.deepEqual(note.inlineTags, ['习惯']);
  assert.match(note.excerpt, /^标题 见 命名 和 测试 › 断言，#习惯/);
  assert.equal(note.excerpt.includes('也不是'), false, 'code blocks stay out of the excerpt');
});

test('files written by other programs keep the fields TaskPilot does not know', async () => {
  const configDir = await dir();
  await fs.mkdir(notesDir(configDir), { recursive: true });
  await fs.writeFile(path.join(notesDir(configDir), 'Obsidian.md'), '---\naliases: [别名]\ntags: a, b\ncssclass: wide\n---\n正文\n');
  await fs.writeFile(path.join(notesDir(configDir), 'ignored.txt'), 'x');
  await fs.mkdir(path.join(notesDir(configDir), 'sub'));
  await fs.writeFile(path.join(notesDir(configDir), 'sub', 'deep.md'), 'x');
  const store = await open(configDir);
  assert.deepEqual(
    store.list().notes.map((note) => note.id),
    ['Obsidian.md'],
    'only top-level .md files',
  );
  const note = store.get('Obsidian.md');
  assert.deepEqual(note.tags, ['a', 'b']);
  await store.update(note.id, edit(note, { title: 'Obsidian', body: '新正文\n', category: 'style', tags: ['a'] }));
  const raw = await fs.readFile(path.join(notesDir(configDir), 'Obsidian.md'), 'utf8');
  assert.match(raw, /aliases: \[ 别名 \]/);
  assert.match(raw, /cssclass: wide/);
  assert.match(raw, /category: style/);
  assert.match(raw, /---\n新正文\n$/);
});

test('a note before course packs keeps its category and gains no course through load, save and summary', async () => {
  const configDir = await dir();
  await fs.mkdir(notesDir(configDir), { recursive: true });
  const file = path.join(notesDir(configDir), '旧笔记.md');
  await fs.writeFile(file, '---\ncategory: thinking\ntags: [a]\n---\n正文\n');
  const store = await open(configDir);
  const note = store.get('旧笔记.md');
  assert.equal(note.category, 'thinking');
  assert.equal(note.course, null, 'no course is programming');
  const saved = (await store.update(note.id, edit(note, { title: '旧笔记', body: '新正文\n', category: 'thinking', course: 'programming', tags: ['a'] }))).note;
  await store.setSummary(note.id, '一句总结', saved.version);
  const raw = await fs.readFile(file, 'utf8');
  assert.match(raw, /^---\ncategory: thinking\n/);
  assert.equal(raw.includes('course'), false, 'saving programming over no course writes nothing');
});

test('a category or course written elsewhere is kept as written, known to TaskPilot or not', async () => {
  const configDir = await dir();
  await fs.mkdir(notesDir(configDir), { recursive: true });
  const unknown = path.join(notesDir(configDir), '外部.md');
  const odd = path.join(notesDir(configDir), '怪值.md');
  await fs.writeFile(unknown, '---\ncategory: concurrency\ncourse: os\n---\n正文\n');
  await fs.writeFile(odd, '---\ncategory: [1, 2]\ncourse: 3\n---\n正文\n');
  const store = await open(configDir);
  assert.deepEqual([store.get('外部.md').category, store.get('外部.md').course], ['concurrency', 'os']);
  assert.deepEqual([store.get('怪值.md').category, store.get('怪值.md').course], [null, null], 'values TaskPilot cannot read show as none');
  const first = store.get('外部.md');
  await store.update(first.id, edit(first, { title: '外部', body: '改了\n', category: 'concurrency', tags: [] }));
  assert.equal(await fs.readFile(unknown, 'utf8'), '---\ncategory: concurrency\ncourse: os\n---\n改了\n');
  const second = store.get('怪值.md');
  await store.update(second.id, edit(second, { title: '怪值', body: '改了\n', category: null, course: null, tags: [] }));
  assert.equal(await fs.readFile(odd, 'utf8'), '---\ncategory: [ 1, 2 ]\ncourse: 3\n---\n改了\n', 'unchanged fields are not rewritten');
  const third = store.get('外部.md');
  const moved = (await store.update(third.id, edit(third, { title: '外部', body: '改了\n', category: 'style', course: null, tags: [] }))).note;
  assert.deepEqual([moved.category, moved.course], ['style', null]);
  assert.equal(await fs.readFile(unknown, 'utf8'), '---\ncategory: style\n---\n改了\n');
});

test('a save refuses to overwrite a file another program changed, unless forced', async () => {
  const configDir = await dir();
  const store = await open(configDir);
  const { note } = await store.create(input());
  await fs.writeFile(path.join(notesDir(configDir), note.id), '外部改的\n');
  await assert.rejects(() => store.update(note.id, edit(note, { body: '我的' })), { code: 'note_conflict' });
  assert.equal(store.get(note.id).body, '外部改的\n', 'the check reread the file');
  const saved = await store.update(note.id, edit(note, { body: '我的', force: true }));
  assert.equal(saved.note.body, '我的');
});

test('a note with broken frontmatter is shown but never saved over', async () => {
  const configDir = await dir();
  await fs.mkdir(notesDir(configDir), { recursive: true });
  await fs.writeFile(path.join(notesDir(configDir), '坏的.md'), '---\na: [\n---\n正文\n');
  const store = await open(configDir);
  const note = store.get('坏的.md');
  assert.equal(note.frontmatterError, true);
  assert.equal(note.body, '正文\n');
  await assert.rejects(() => store.update(note.id, edit(note, { title: '坏的' })), { code: 'frontmatter_invalid' });
});

test('renaming moves the file and, when asked, points [[old title]] elsewhere at the new one', async () => {
  const configDir = await dir();
  const store = await open(configDir);
  const { note } = await store.create(input({ title: '命名' }));
  const linking = (await store.create(input({ title: '引用', body: '见 [[命名]]、[[命名#小节|这里]] 和 `[[命名]]`' }))).note;
  const untouched = (await store.create(input({ title: '无关', body: '[[别的]]' }))).note;
  const saved = await store.update(note.id, edit(note, { title: '变量命名', renameLinks: true }));
  assert.equal(saved.note.id, '变量命名.md');
  assert.equal(saved.relinked, 1);
  await assert.rejects(() => fs.stat(path.join(notesDir(configDir), '命名.md')), { code: 'ENOENT' });
  assert.equal(store.get(linking.id).body, '见 [[变量命名]]、[[变量命名#小节|这里]] 和 `[[命名]]`');
  assert.match(await fs.readFile(path.join(notesDir(configDir), linking.id), 'utf8'), /^---\ncategory: thinking/, 'the frontmatter is kept');
  assert.equal(store.get(untouched.id).version, untouched.version);

  const again = store.get('变量命名.md');
  await assert.rejects(() => store.update(again.id, edit(again, { title: '引用' })), { code: 'note_exists' });
  const caseOnly = await store.update(again.id, edit(again, { title: '变量命名X' }));
  assert.equal((await store.update(caseOnly.note.id, edit(caseOnly.note, { title: '变量命名x' }))).note.id, '变量命名x.md');
});

test('a summary is pinned to the body it summarised', async () => {
  const store = await open(await dir());
  const { note } = await store.create(input());
  const summarized = (await store.setSummary(note.id, '先写会失败的测试再实现。', note.version)).note;
  assert.equal(summarized.summary, '先写会失败的测试再实现。');
  assert.equal(summarized.summaryStale, false);
  const edited = (await store.update(note.id, edit(summarized, { body: '改了' }))).note;
  assert.equal(edited.summary, '先写会失败的测试再实现。', 'kept when the edit leaves it out');
  assert.equal(edited.summaryStale, true);
  assert.equal((await store.update(note.id, edit(edited, { summary: null }))).note.summary, null);
  await assert.rejects(() => store.setSummary(note.id, 'x', note.version), { code: 'note_conflict' });
});

test('bad input is refused field by field', () => {
  for (const [bad, field] of [
    [input({ title: ' ' }), 'title'],
    [input({ title: 'a/b' }), 'title'],
    [input({ title: '[[x]]' }), 'title'],
    [input({ title: 'x'.repeat(81) }), 'title'],
    [input({ body: 'a‮b' }), 'body'],
    [input({ category: 'Mood!' }), 'category'],
    [input({ course: '../os' }), 'course'],
    [input({ tags: Array(9).fill('t') }), 'tags'],
    [input({ source: { line: 0 } }), 'source.line'],
    [input({ source: 'x' }), 'source'],
  ] as const)
    assert.throws(() => validateNote(bad), { code: 'invalid_note', field }, field);
  assert.equal(validateNote(input({ body: 'x'.repeat(100_000) })).body.length, 100_000, 'bodies have no length limit');
});

// Writes and reads 5002 files.
test('a full notebook refuses new notes and deletes nothing', { tags: ['integration'] }, async () => {
  const configDir = await dir();
  await fs.mkdir(notesDir(configDir), { recursive: true });
  await Promise.all(Array.from({ length: MAX_NOTES + 2 }, (_unused, index) => fs.writeFile(path.join(notesDir(configDir), `n${index}.md`), `${index}`)));
  const store = await open(configDir);
  assert.equal(store.list().notes.length, MAX_NOTES);
  assert.equal(store.list().truncated, true);
  await assert.rejects(() => store.create(input()), { code: 'notes_full' });
  assert.equal((await fs.readdir(notesDir(configDir))).length, MAX_NOTES + 2);
});

test('deleting hands the file to the trash', async () => {
  const configDir = await dir();
  const trashed: string[] = [];
  const store = await open(configDir, { trash: async (file: string) => void trashed.push(file) });
  const { note } = await store.create(input());
  await store.remove(note.id);
  assert.deepEqual(trashed, [path.join(notesDir(configDir), note.id)]);
  assert.deepEqual(store.list().notes, []);
  await assert.rejects(() => store.remove(note.id), { code: 'unknown_note' });
});

test('a chosen folder is remembered; a missing one falls back to the default and says so', async () => {
  const configDir = await dir();
  const vault = await dir();
  await fs.writeFile(path.join(vault, '库里的.md'), 'x');
  const store = await open(configDir);
  const list = await store.setDirectory(vault);
  assert.equal(list.custom, true);
  assert.deepEqual(
    list.notes.map((note) => note.id),
    ['库里的.md'],
  );
  assert.equal(JSON.parse(await fs.readFile(path.join(configDir, LOCATION_FILENAME), 'utf8')).directory, vault);
  assert.equal((await open(configDir)).directory, vault);
  await assert.rejects(() => store.setDirectory(path.join(vault, 'nope')), { code: 'notes_directory_invalid' });

  await fs.rm(vault, { recursive: true });
  captureExpectedErrors((error) => 'code' in error && error.code === 'notes_directory_invalid');
  const fallback = await open(configDir);
  assert.equal(fallback.directory, notesDir(configDir));
  assert.equal(fallback.list().unavailable, vault);
  assert.equal((await store.setDirectory(null)).custom, false);
  await assert.rejects(() => fs.access(path.join(configDir, LOCATION_FILENAME)), { code: 'ENOENT' });
});

test('the watcher picks up files changed by other programs', async () => {
  const configDir = await dir();
  const store = await open(configDir, { watch: true });
  const before = store.revision;
  const file = path.join(notesDir(configDir), '外部.md');
  // macOS FSEvents can drop events from just after a watch starts, so the
  // outside program saves again each second (past the store's 200ms
  // debounce) until the store has seen it.
  let savedAt = 0;
  const seen = async () => {
    const note = store.list().notes.find((entry) => entry.id === '外部.md');
    if (!note && Date.now() - savedAt > 1000) {
      savedAt = Date.now();
      await fs.writeFile(file, '来自 Obsidian\n');
    }
    return note;
  };
  await until(seen, (note) => !!note, 'external note appears');
  assert.equal(store.get('外部.md').body, '来自 Obsidian\n');
  assert.ok(store.revision > before);
  await fs.unlink(file);
  await until(
    () => store.list().notes,
    (notes) => notes.length === 0,
    'external note removed',
  );
});

test('search matches title, tags and body in any case', async () => {
  const store = await open(await dir());
  await store.create(input({ title: 'Naming', body: 'use FULL words', tags: ['style'] }));
  await store.create(input({ title: '其他', body: '', tags: [] }));
  assert.deepEqual(store.search('full'), ['Naming.md']);
  assert.deepEqual(store.search('STYLE'), ['Naming.md']);
  assert.deepEqual(store.search(' '), []);
});

test('concepts are kept in the frontmatter, checked on save and read loosely', async () => {
  const configDir = await dir();
  const store = await open(configDir, { now: () => new Date('2026-10-24T00:00:00Z') });
  const { note } = await store.create(
    input({ title: '轮转', category: 'concept', course: 'os', concepts: ['round-robin', 'ai:quantum', 'round-robin'], tags: [] }),
  );
  assert.deepEqual(note.concepts, ['round-robin', 'ai:quantum']);
  const raw = await fs.readFile(path.join(notesDir(configDir), note.id), 'utf8');
  assert.match(raw, /\nconcepts:\n {2}- round-robin\n {2}- ai:quantum\n/);
  await assert.rejects(() => store.create(input({ title: '坏', concepts: ['Round Robin'] })), { code: 'invalid_note' });
  // An edit that leaves concepts out keeps them.
  const { note: edited } = await store.update(note.id, edit(note, { title: '轮转', category: 'concept' }));
  assert.deepEqual(edited.concepts, ['round-robin', 'ai:quantum']);
  const { note: cleared } = await store.update(note.id, edit(edited, { title: '轮转', concepts: [] }));
  assert.deepEqual(cleared.concepts, []);
  assert.doesNotMatch(await fs.readFile(path.join(notesDir(configDir), note.id), 'utf8'), /concepts/);
  // Written by hand: what is not a concept id is left out of the note's fields.
  await fs.writeFile(path.join(notesDir(configDir), '手写.md'), '---\nconcepts: [paging, Not Valid, 3]\n---\nbody\n');
  await fs.writeFile(path.join(notesDir(configDir), '没有.md'), 'body\n');
  const reopened = await open(configDir);
  assert.deepEqual(reopened.get('手写.md').concepts, ['paging']);
  assert.deepEqual(reopened.get('没有.md').concepts, []);
});
