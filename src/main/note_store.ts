// Learning notes as a folder of Markdown files, readable by Obsidian or any
// editor: one note per top-level .md file, its title the file name, its body
// Markdown. TaskPilot's fields (category, course, tags, source, summary,
// created) live in the YAML frontmatter, beside any fields other programs put
// there, which are kept as written; a save only writes the fields it changes.
// Notes follow the developer across repositories.
//
// The folder is userData/notes unless the developer chose another one (an
// existing Obsidian vault, say). Other programs may change the files at any
// time: a watcher rereads them, and a save refuses to overwrite a file that
// changed since the editor read it unless asked to. A note whose frontmatter
// is not valid YAML is shown but not saved, so its fields are never lost.
//
// [人工决策-2026-10-24 14:25:15] 笔记全局一份，上限 5000 条，满了拒绝新增、不自动删除。
// [人工决策-2026-10-24 16:12:00] 笔记改为 .md 文件目录（默认 userData/notes，可改），监听外部修改、冲突时让用户选覆盖或放弃；正文不限长度，判卷只读标题 + AI 总结（手动生成）。
// [人工决策-2026-10-26 15:38:21] 笔记新增可选 course 字段，没有的视为 programming，旧文件不迁移；category 是课程包
// rubric 项的 id，任意合法 id 都原样保留（不认识的包或维度也不读成 null）。
// [人工决策-2026-10-27 00:36:21] 笔记 frontmatter 新增 concepts（课程包知识点 id），从判卷存的笔记自动带上工作包的 concepts，供复习排期用。
import { createHash, randomUUID } from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';

import * as markdown from '../shared/note_markdown.ts';
import { DEFAULT_COURSE_ID, isCourseId } from '../shared/course_pack.ts';
import { CONTROL_CHARS } from '../shared/text_rules.ts';
import { writeFileAtomic } from './atomic_json_file.ts';
import { isLabConcept } from './project_config.ts';
import type * as noteTypes from '../shared/ipc/notes.ts';
import type { GradeCategory } from '../shared/ipc/packages.ts';

export const DEFAULT_DIRNAME = 'notes';
// Which folder the developer chose; absent means the default one.
export const LOCATION_FILENAME = 'notes_location.json';
export const MAX_NOTES = 5000;
export const MAX_SUMMARY = 300;
const EXCERPT_LENGTH = 300;
const MAX_TAGS = 8;
const MAX_CONCEPTS = 8;
const MAX_TAG = 20;
const WATCH_DEBOUNCE_MS = 200;
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

export class NoteError extends Error {
  code: string;
  field: string | undefined;

  constructor(message: string, code: string, field?: string) {
    super(message);
    this.name = 'NoteError';
    this.code = code;
    this.field = field;
  }
}

const fail: (message: string, field: string) => never = (message, field) => {
  throw new NoteError(message, 'invalid_note', field);
};

const text = (value: unknown, field: string, max: number): string => {
  if (typeof value !== 'string') fail(`${field} must be text`, field);
  const trimmed = value.trim();
  if (!trimmed) fail(`${field} is empty`, field);
  if ([...trimmed].length > max) fail(`${field} is longer than ${max} characters`, field);
  if (CONTROL_CHARS.test(trimmed)) fail(`${field} contains control characters`, field);
  return trimmed;
};

const title = (value: unknown): string => {
  if (typeof value !== 'string') fail('title must be text', 'title');
  const problem = markdown.titleProblem(value.trim());
  if (problem) fail(problem, 'title');
  return value.trim();
};

// Bodies are the developer's Markdown, any length; only stray control
// characters are refused (newlines, tabs and carriage returns are fine).
const body = (value: unknown): string => {
  if (typeof value !== 'string') fail('body must be text', 'body');
  if (CONTROL_CHARS.test(value)) fail('body contains control characters', 'body');
  return value;
};

// A rubric item id of any pack, known here or not.
const category = (value: unknown): GradeCategory | null => {
  if (value !== null && value !== undefined && !isCourseId(value)) fail('category must be a rubric item id', 'category');
  return (value ?? null) as GradeCategory | null;
};

const course = (value: unknown): string | null => {
  if (value !== null && value !== undefined && !isCourseId(value)) fail('course must be a course pack id', 'course');
  return (value ?? null) as string | null;
};

// Concept ids of a pack's skeleton, or `ai:` ones of a course plan.
const concepts = (value: unknown): string[] => {
  const list = value ?? [];
  if (!Array.isArray(list) || list.length > MAX_CONCEPTS || !list.every(isLabConcept))
    fail(`concepts must be a list of at most ${MAX_CONCEPTS} concept ids`, 'concepts');
  return [...new Set(list as string[])];
};

const tags = (value: unknown): string[] => {
  const list = value ?? [];
  if (!Array.isArray(list) || list.length > MAX_TAGS) fail(`tags must be a list of at most ${MAX_TAGS}`, 'tags');
  return [...new Set(list.map((tag, index) => text(typeof tag === 'string' ? tag.replace(/^#/, '') : tag, `tags[${index}]`, MAX_TAG)))];
};

const source = (value: unknown): noteTypes.NoteSource | null => {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) fail('source must be an object', 'source');
  const raw = value as Record<string, unknown>;
  const optional = (field: string, max: number) => (raw[field] === null || raw[field] === undefined ? null : text(raw[field], `source.${field}`, max));
  const line = raw.line;
  if (line !== null && line !== undefined && (!Number.isInteger(line) || (line as number) < 1)) fail('source.line must be a positive integer', 'source.line');
  return {
    repositoryId: optional('repositoryId', 64),
    repositoryName: optional('repositoryName', 200),
    packageId: optional('packageId', 200),
    packageTitle: optional('packageTitle', 200),
    file: optional('file', 500),
    line: (line as number | null | undefined) ?? null,
  };
};

const summary = (value: unknown): string | null => (value === null ? null : text(value, 'summary', MAX_SUMMARY));

// Checks a new note from the renderer; the id and times are the store's own.
export const validateNote = (raw: unknown): noteTypes.NoteInput => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('A note must be an object', 'note');
  const input = raw as Record<string, unknown>;
  return {
    title: title(input.title),
    body: body(input.body ?? ''),
    category: category(input.category),
    course: course(input.course),
    concepts: concepts(input.concepts),
    tags: tags(input.tags),
    source: source(input.source),
  };
};

const digest = (content: string) => createHash('sha256').update(content).digest('hex').slice(0, 16);
const fileName = (noteTitle: string) => `${noteTitle}.md`;

// ========== Reading a file ==========

type Parsed = { doc: YAML.Document | null; head: string; body: string; frontmatterError: boolean };

const parseFile = (raw: string): Parsed => {
  const match = FRONTMATTER.exec(raw);
  if (!match) return { doc: null, head: '', body: raw, frontmatterError: false };
  const doc = YAML.parseDocument(match[1]);
  const valid = doc.errors.length === 0 && (doc.contents === null || YAML.isMap(doc.contents));
  return { doc: valid ? doc : null, head: match[0], body: raw.slice(match[0].length), frontmatterError: !valid };
};

// Frontmatter written by hand or by other programs: anything unexpected is
// left out of the note's fields (and left in the file).
const loose = {
  string: (value: unknown, max: number) => (typeof value === 'string' && value.trim() && [...value.trim()].length <= max ? value.trim() : null),
  tags: (value: unknown): string[] => {
    const list = typeof value === 'string' ? value.split(/[,\s]+/) : Array.isArray(value) ? value : [];
    return [
      ...new Set(
        list
          .filter((tag): tag is string => typeof tag === 'string')
          .map((tag) => tag.replace(/^#/, '').trim())
          .filter(Boolean),
      ),
    ];
  },
  source: (value: unknown): noteTypes.NoteSource | null => {
    try {
      return source(value);
    } catch {
      return null;
    }
  },
};

// head: the frontmatter block exactly as written, '' when there is none.
type Entry = { meta: noteTypes.NoteMeta; body: string; doc: YAML.Document | null; head: string };

const toEntry = (id: string, raw: string, stat: { birthtime: Date; mtime: Date }): Entry => {
  const parsed = parseFile(raw);
  const fields = (parsed.doc?.toJS() ?? {}) as Record<string, unknown>;
  const tree = markdown.parseMarkdown(parsed.body);
  const scan = markdown.scanBody(parsed.body, tree);
  const links = [...new Map(scan.links.map((link) => [markdown.titleKey(link.target), link.target])).values()];
  const excerpt = markdown.excerptOf(tree, id.slice(0, -'.md'.length));
  const savedSummary = loose.string(fields.summary, MAX_SUMMARY * 2);
  const created = typeof fields.created === 'string' && !Number.isNaN(Date.parse(fields.created)) ? new Date(fields.created) : stat.birthtime;
  return {
    meta: {
      id,
      title: id.slice(0, -'.md'.length),
      category: isCourseId(fields.category) ? fields.category : null,
      course: isCourseId(fields.course) ? fields.course : null,
      concepts: Array.isArray(fields.concepts) ? [...new Set(fields.concepts.filter(isLabConcept))] : [],
      tags: loose.tags(fields.tags),
      inlineTags: scan.tags,
      source: loose.source(fields.source),
      summary: savedSummary,
      summaryStale: savedSummary !== null && fields.summaryFor !== digest(parsed.body),
      links,
      excerpt: [...excerpt].length > EXCERPT_LENGTH ? `${[...excerpt].slice(0, EXCERPT_LENGTH).join('')}…` : excerpt,
      createdAt: created.toISOString(),
      updatedAt: stat.mtime.toISOString(),
      version: digest(raw),
      frontmatterError: parsed.frontmatterError,
    },
    body: parsed.body,
    doc: parsed.doc,
    head: parsed.head,
  };
};

// A field left out (undefined) keeps what the file says, even a value
// TaskPilot could not read.
type Fields = {
  category?: GradeCategory | null;
  course?: string | null;
  concepts?: string[];
  tags?: string[];
  source?: noteTypes.NoteSource | null;
  summary?: string | null;
  created?: string;
};

// The file for a body and fields, keeping every other frontmatter field.
const render = (doc: YAML.Document | null, noteBody: string, fields: Fields): string => {
  const next = doc ? doc.clone() : new YAML.Document({});
  const put = (key: string, value: unknown) => {
    if (value === null || value === undefined || (Array.isArray(value) && !value.length)) next.delete(key);
    else next.set(key, value);
  };
  if (fields.category !== undefined) put('category', fields.category);
  if (fields.course !== undefined) put('course', fields.course);
  if (fields.concepts !== undefined) put('concepts', fields.concepts);
  if (fields.tags !== undefined) put('tags', fields.tags);
  if (fields.source !== undefined) put('source', fields.source && Object.fromEntries(Object.entries(fields.source).filter(([, value]) => value !== null)));
  if (fields.summary !== undefined) {
    put('summary', fields.summary);
    put('summaryFor', fields.summary === null ? null : digest(noteBody));
  }
  if (fields.created) put('created', fields.created);
  const yaml = YAML.isMap(next.contents) && next.contents.items.length ? String(next) : '';
  return yaml ? `---\n${yaml}---\n${noteBody}` : noteBody;
};

// The fields an edit sets, checked.
const editedFields = (input: Record<string, unknown>): Fields => {
  const fields: Fields = { category: category(input.category), tags: tags(input.tags) };
  if (input.course !== undefined) fields.course = course(input.course);
  if (input.concepts !== undefined) fields.concepts = concepts(input.concepts);
  if (input.summary !== undefined) fields.summary = summary(input.summary);
  return fields;
};

// Category and course are only written when they change, so a value as
// another program wrote it stays. No course is programming, so writing one
// over the other changes nothing.
const changedFields = ({ category: nextCategory, course: nextCourse, ...rest }: Fields, meta: noteTypes.NoteMeta): Fields => {
  const fields: Fields = rest;
  const courseOf = (value: string | null) => value ?? DEFAULT_COURSE_ID;
  if (nextCategory !== meta.category) fields.category = nextCategory;
  if (nextCourse !== undefined && courseOf(nextCourse) !== courseOf(meta.course)) fields.course = nextCourse;
  return fields;
};

// ========== The store ==========

export type NoteEditInput = {
  title: string;
  body: string;
  category: GradeCategory | null;
  course?: string | null;
  concepts?: string[];
  tags: string[];
  summary?: string | null;
  baseVersion: string;
  force?: boolean;
  renameLinks?: boolean;
};

type StoreOptions = {
  now?: () => Date;
  // Moves a deleted note's file to the system trash; tests unlink instead.
  trash?: (file: string) => Promise<void>;
  watch?: boolean;
};

export class NoteStore {
  #configDir: string;
  #directory: string;
  #custom = false;
  // A chosen folder that could not be opened at startup.
  #unavailable: string | null = null;
  #entries = new Map<string, Entry>();
  #truncated = false;
  #revision = 0;
  #writes: Promise<unknown> = Promise.resolve();
  #watcher: fsSync.FSWatcher | null = null;
  #pending = new Set<string>();
  #rescanAll = false;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #refreshing: Promise<void> = Promise.resolve();
  #now: () => Date;
  #trash: (file: string) => Promise<void>;
  #watch: boolean;

  constructor(configDir: string, { now = () => new Date(), trash = (file) => fs.unlink(file), watch = true }: StoreOptions = {}) {
    this.#configDir = configDir;
    this.#directory = path.join(configDir, DEFAULT_DIRNAME);
    this.#now = now;
    this.#trash = trash;
    this.#watch = watch;
  }

  get directory() {
    return this.#directory;
  }

  get revision() {
    return this.#revision;
  }

  // Opens the folder chosen last time, or the default one when that folder
  // is gone (the list then names it, so the notes do not just disappear).
  async load(): Promise<this> {
    const chosen = await fs
      .readFile(path.join(this.#configDir, LOCATION_FILENAME), 'utf8')
      .then((raw) => (JSON.parse(raw) as { directory?: unknown }).directory)
      .catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error('[notes] notes_location.json could not be read', error);
        return null;
      });
    if (typeof chosen !== 'string' || !path.isAbsolute(chosen)) return this.open(null);
    try {
      return await this.open(chosen);
    } catch (error) {
      console.error(`[notes] the chosen notes folder could not be opened: ${chosen}`, error);
      this.#unavailable = chosen;
      return this.open(null);
    }
  }

  // Switches folders and remembers the choice; files are not moved.
  async setDirectory(directory: string | null): Promise<noteTypes.NoteList> {
    await this.open(directory);
    this.#unavailable = null;
    const file = path.join(this.#configDir, LOCATION_FILENAME);
    if (directory) await fs.writeFile(file, `${JSON.stringify({ directory: this.#directory }, null, 2)}\n`);
    else await fs.rm(file, { force: true });
    return this.list();
  }

  // Opens a folder: the default one (null) is created; a chosen one must
  // already exist.
  async open(directory: string | null = null): Promise<this> {
    const target = directory ? path.resolve(directory) : path.join(this.#configDir, DEFAULT_DIRNAME);
    if (directory) {
      const stat = await fs.stat(target).catch(() => null);
      if (!stat?.isDirectory()) throw new NoteError('The notes folder does not exist', 'notes_directory_invalid', 'directory');
    } else {
      await fs.mkdir(target, { recursive: true });
    }
    await this.flush();
    this.close();
    this.#directory = target;
    this.#custom = Boolean(directory);
    await this.#scan();
    if (this.#watch) this.#startWatching();
    console.debug(`[notes] open directory=${target} notes=${this.#entries.size} truncated=${this.#truncated}`);
    return this;
  }

  close() {
    this.#watcher?.close();
    this.#watcher = null;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  async flush(): Promise<void> {
    await this.#writes;
    await this.#refreshing;
  }

  list(): noteTypes.NoteList {
    const notes = [...this.#entries.values()].map((entry) => structuredClone(entry.meta)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { revision: this.#revision, directory: this.#directory, custom: this.#custom, unavailable: this.#unavailable, truncated: this.#truncated, notes };
  }

  get(id: string): noteTypes.Note {
    const entry = this.#entries.get(id);
    if (!entry) throw new NoteError(`Unknown note: ${id}`, 'unknown_note');
    return { ...structuredClone(entry.meta), body: entry.body };
  }

  // Ids of notes whose title, tags or body contain the query, any case.
  search(query: string): string[] {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    return [...this.#entries.values()]
      .filter((entry) => [entry.meta.title, ...entry.meta.tags, entry.body].some((part) => part.toLowerCase().includes(needle)))
      .map((entry) => entry.meta.id);
  }

  // autoRename: a taken title gets " 2", " 3"… instead of being refused.
  create(raw: unknown, { autoRename = false } = {}): Promise<noteTypes.NoteSaved> {
    return this.#serial(async () => {
      const input = validateNote(raw);
      if (this.#entries.size >= MAX_NOTES) throw new NoteError(`At most ${MAX_NOTES} notes`, 'notes_full');
      const noteTitle = autoRename ? this.#freeTitle(input.title) : input.title;
      if (this.#taken(noteTitle)) throw new NoteError('A note with this title already exists', 'note_exists', 'title');
      const content = render(null, input.body, { ...input, created: this.#now().toISOString() });
      const id = fileName(noteTitle);
      await this.#writeFile(id, content, { exclusive: true });
      await this.#reread(id);
      console.debug(`[notes] create id=${id}`);
      return { revision: this.#revision, note: this.get(id), relinked: 0 };
    });
  }

  // Saves the developer's edit; the source stays as recorded. A rename moves
  // the file and, when asked, points [[old title]] in other notes at the new one.
  update(id: string, raw: unknown): Promise<noteTypes.NoteSaved> {
    return this.#serial(async () => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('An edit must be an object', 'note');
      const input = raw as Record<string, unknown>;
      if (typeof input.baseVersion !== 'string') fail('baseVersion is required', 'baseVersion');
      const nextTitle = title(input.title);
      const nextBody = body(input.body);
      const edited = editedFields(input);
      const current = await this.#fresh(id);
      const fields = changedFields(edited, current.meta);
      if (current.meta.frontmatterError)
        throw new NoteError('The frontmatter of this note is not valid YAML; fix it in another editor first', 'frontmatter_invalid');
      if (current.meta.version !== input.baseVersion && input.force !== true)
        throw new NoteError('The note changed on disk since it was opened', 'note_conflict');
      const renamed = nextTitle !== current.meta.title;
      // Only the case changes: on a case-insensitive disk that is the same file.
      const caseOnly = renamed && markdown.titleKey(nextTitle) === markdown.titleKey(current.meta.title);
      if (renamed && !caseOnly && this.#taken(nextTitle)) throw new NoteError('A note with this title already exists', 'note_exists', 'title');
      const content = render(current.doc, nextBody, fields);
      const nextId = fileName(nextTitle);
      if (renamed && !caseOnly) {
        await this.#writeFile(nextId, content, { exclusive: true });
        await fs.unlink(this.#path(id));
      } else {
        await this.#writeFile(id, content);
        if (caseOnly) await fs.rename(this.#path(id), this.#path(nextId));
      }
      if (renamed) this.#entries.delete(id);
      await this.#reread(nextId);
      const relinked = renamed && input.renameLinks === true ? await this.#relink(current.meta.title, nextTitle, nextId) : 0;
      console.debug(`[notes] update id=${id} next=${nextId} relinked=${relinked}`);
      return { revision: this.#revision, note: this.get(nextId), relinked };
    });
  }

  // Writes Tutor's (or the developer's) summary without touching the body.
  setSummary(id: string, value: string, baseVersion: string): Promise<noteTypes.NoteSaved> {
    return this.#serial(async () => {
      const current = await this.#fresh(id);
      if (current.meta.frontmatterError) throw new NoteError('The frontmatter of this note is not valid YAML', 'frontmatter_invalid');
      if (current.meta.version !== baseVersion) throw new NoteError('The note changed on disk since it was opened', 'note_conflict');
      const content = render(current.doc, current.body, { summary: summary(value) });
      await this.#writeFile(id, content);
      await this.#reread(id);
      return { revision: this.#revision, note: this.get(id), relinked: 0 };
    });
  }

  remove(id: string): Promise<void> {
    return this.#serial(async () => {
      this.get(id);
      await this.#trash(this.#path(id));
      this.#entries.delete(id);
      this.#revision += 1;
    });
  }

  #path(id: string) {
    return path.join(this.#directory, id);
  }

  #taken(noteTitle: string) {
    const key = markdown.titleKey(noteTitle);
    return [...this.#entries.values()].some((entry) => markdown.titleKey(entry.meta.title) === key);
  }

  #freeTitle(base: string): string {
    if (!this.#taken(base)) return base;
    for (let index = 2; ; index += 1) {
      const suffix = ` ${index}`;
      const candidate = `${[...base]
        .slice(0, markdown.MAX_TITLE - suffix.length)
        .join('')
        .trim()}${suffix}`;
      if (!this.#taken(candidate)) return candidate;
    }
  }

  // Store writes run one at a time, so a rename never races another save.
  #serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#writes.then(task);
    this.#writes = run.catch(() => {});
    return run;
  }

  // Through a hidden temp file in the same folder, so other programs never
  // see half a note. exclusive: refuse when the file already exists.
  async #writeFile(id: string, content: string, { exclusive = false } = {}) {
    const target = this.#path(id);
    if (exclusive && (await fs.stat(target).catch(() => null))) throw new NoteError('A note with this title already exists', 'note_exists', 'title');
    await writeFileAtomic(target, content, { tmp: path.join(this.#directory, `.${randomUUID()}.tmp`) });
  }

  // The note as it is on disk now, for checks that must not trust the cache.
  async #fresh(id: string): Promise<Entry> {
    this.get(id);
    await this.#reread(id);
    const entry = this.#entries.get(id);
    if (!entry) throw new NoteError(`Unknown note: ${id}`, 'unknown_note');
    return entry;
  }

  // Rereads one file; returns whether anything the list shows changed.
  async #reread(id: string): Promise<boolean> {
    const file = this.#path(id);
    const [raw, stat] = await Promise.all([fs.readFile(file, 'utf8').catch(() => null), fs.stat(file).catch(() => null)]);
    const before = this.#entries.get(id);
    if (raw === null || !stat?.isFile()) {
      if (!before) return false;
      this.#entries.delete(id);
      this.#revision += 1;
      return true;
    }
    if (!before && this.#entries.size >= MAX_NOTES) {
      this.#truncated = true;
      return false;
    }
    const entry = toEntry(id, raw, stat);
    if (before && before.meta.version === entry.meta.version && before.meta.updatedAt === entry.meta.updatedAt) return false;
    this.#entries.set(id, entry);
    this.#revision += 1;
    return true;
  }

  async #relink(from: string, to: string, skipId: string): Promise<number> {
    const key = markdown.titleKey(from);
    let count = 0;
    for (const entry of [...this.#entries.values()]) {
      if (entry.meta.id === skipId || entry.meta.frontmatterError || !entry.meta.links.some((link) => markdown.titleKey(link) === key)) continue;
      const current = await this.#fresh(entry.meta.id);
      const nextBody = markdown.renameLinks(current.body, from, to);
      if (nextBody === current.body) continue;
      // Only the body changes; the frontmatter is written back as it was.
      await this.#writeFile(entry.meta.id, `${current.head}${nextBody}`);
      await this.#reread(entry.meta.id);
      count += 1;
    }
    return count;
  }

  // Every top-level .md file; past MAX_NOTES the newest are kept.
  async #scan() {
    const names = (await fs.readdir(this.#directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md') && !entry.name.startsWith('.'))
      .map((entry) => entry.name);
    const stats = await Promise.all(names.map(async (name) => ({ name, stat: await fs.stat(this.#path(name)).catch(() => null) })));
    const kept = stats.filter((item) => item.stat).sort((a, b) => b.stat!.mtimeMs - a.stat!.mtimeMs);
    this.#truncated = kept.length > MAX_NOTES;
    this.#entries.clear();
    // Reads in slices so a large vault does not open thousands of files at once.
    const slice = 64;
    const chosen = kept.slice(0, MAX_NOTES);
    for (let start = 0; start < chosen.length; start += slice) {
      const batch = await Promise.all(
        chosen.slice(start, start + slice).map(async (item) => ({ item, raw: await fs.readFile(this.#path(item.name), 'utf8').catch(() => null) })),
      );
      for (const { item, raw } of batch) if (raw !== null) this.#entries.set(item.name, toEntry(item.name, raw, item.stat!));
    }
    this.#revision += 1;
  }

  #startWatching() {
    try {
      this.#watcher = fsSync.watch(this.#directory, (_event, name) => {
        if (name && (name.startsWith('.') || !name.toLowerCase().endsWith('.md'))) return;
        if (name) this.#pending.add(name);
        else this.#rescanAll = true;
        if (this.#timer) clearTimeout(this.#timer);
        this.#timer = setTimeout(() => {
          this.#timer = null;
          this.#refreshing = this.#refreshing.then(() => this.#applyPending()).catch((error) => console.error('[notes] refresh failed', error));
        }, WATCH_DEBOUNCE_MS);
      });
      this.#watcher.on('error', (error) => console.error('[notes] watcher failed', error));
      // Watching never keeps the process alive on its own.
      this.#watcher.unref();
    } catch (error) {
      console.error('[notes] cannot watch the notes folder', error);
    }
  }

  async #applyPending() {
    await this.#writes;
    if (this.#rescanAll) {
      this.#rescanAll = false;
      this.#pending.clear();
      await this.#scan();
      return;
    }
    const names = [...this.#pending];
    this.#pending.clear();
    for (const name of names) await this.#reread(name);
  }
}
