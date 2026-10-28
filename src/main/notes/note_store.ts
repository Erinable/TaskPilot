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
import { randomUUID } from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { logger } from '../infrastructure/logger.ts';
import * as markdown from '../../shared/note_markdown.ts';
import { writeFileAtomic } from '../infrastructure/atomic_json_file.ts';
import type * as noteTypes from '../../shared/ipc/notes.ts';
import type { GradeCategory } from '../../shared/ipc/packages.ts';
import { NoteError, fail, validateNote, title, fileName, render, editedFields, changedFields, toEntry, type Entry } from './note_file.ts';
import { body, summary } from './note_file.ts';
import { readStoredJson, writeStoredJson } from '../infrastructure/persisted_json.ts';
import type { StateChanged } from '../infrastructure/state_changes.ts';

export const DEFAULT_DIRNAME = 'notes';
// Which folder the developer chose; absent means the default one.
export const LOCATION_FILENAME = 'notes_location.json';
export const MAX_NOTES = 5000;
export const MAX_SUMMARY = 300;
const WATCH_DEBOUNCE_MS = 200;

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
  #onChanged?: StateChanged;

  setOnChanged(listener: StateChanged): void {
    this.#onChanged = listener;
  }

  #notify() {
    try {
      this.#onChanged?.('notes');
    } catch (error) {
      logger.error('[notes] change listener failed', error);
    }
  }

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
    const chosen = await readStoredJson(path.join(this.#configDir, LOCATION_FILENAME), 1)
      .then((value) => (value && typeof value === 'object' && !Array.isArray(value) ? (value as { directory?: unknown }).directory : undefined))
      .catch((error) => {
        if ((error as NodeJS.ErrnoException).code === 'unsupported_version') throw error;
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') logger.error('[notes] notes_location.json could not be read', error);
        return null;
      });
    if (typeof chosen !== 'string' || !path.isAbsolute(chosen)) return this.open(null);
    try {
      return await this.open(chosen);
    } catch (error) {
      logger.error(`[notes] the chosen notes folder could not be opened: ${chosen}`, error);
      this.#unavailable = chosen;
      return this.open(null);
    }
  }

  // Switches folders and remembers the choice; files are not moved.
  async setDirectory(directory: string | null): Promise<noteTypes.NoteList> {
    const file = path.join(this.#configDir, LOCATION_FILENAME);
    try {
      await readStoredJson(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    await this.open(directory);
    this.#unavailable = null;
    if (directory) await writeStoredJson(file, { version: 1, directory: this.#directory });
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
    this.#notify();
    logger.debug(`[notes] open directory=${target} notes=${this.#entries.size} truncated=${this.#truncated}`);
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
      logger.debug(`[notes] create id=${id}`);
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
      logger.debug(`[notes] update id=${id} next=${nextId} relinked=${relinked}`);
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
      this.#notify();
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
      this.#notify();
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
    this.#notify();
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
          this.#refreshing = this.#refreshing.then(() => this.#applyPending()).catch((error) => logger.error('[notes] refresh failed', error));
        }, WATCH_DEBOUNCE_MS);
      });
      this.#watcher.on('error', (error) => logger.error('[notes] watcher failed', error));
      // Watching never keeps the process alive on its own.
      this.#watcher.unref();
    } catch (error) {
      logger.error('[notes] cannot watch the notes folder', error);
    }
  }

  async #applyPending() {
    await this.#writes;
    if (this.#rescanAll) {
      this.#rescanAll = false;
      this.#pending.clear();
      await this.#scan();
      this.#notify();
    }
    const names = [...this.#pending];
    this.#pending.clear();
    for (const name of names) await this.#reread(name);
  }
}
