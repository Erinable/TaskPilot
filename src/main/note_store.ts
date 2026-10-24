// Learning notes, one global file (userData/notes.json): notes follow the
// developer across repositories, since habits in thinking and style do.
// Each note may point back at where it came from (a repository, package,
// file and line); a note saved from a grade comment carries the comment's
// category. Notes are the developer's own text: the store never trims or
// rewrites them, and never deletes any on its own.
//
// [人工决策-2026-10-24 14:25:15] 笔记全局一份，上限 5000 条，满了拒绝新增、不自动删除。
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { CONTROL_CHARS } from './text_rules.ts';
import type { GradeCategory, Note, NoteInput, NoteSource } from '../shared/ipc_types.ts';

export const NOTES_FILENAME = 'notes.json';
export const MAX_NOTES = 5000;
const MAX_TITLE = 80;
const MAX_BODY = 4000;
const MAX_TAGS = 8;
const MAX_TAG = 20;
const CATEGORIES: (GradeCategory | null)[] = ['thinking', 'writing', 'style', null];

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

// Free text from the renderer; newlines and tabs are the only control
// characters a body may hold.
const text = (value: unknown, field: string, max: number, { multiline = false, required = true } = {}): string => {
  if (typeof value !== 'string') fail(`${field} must be text`, field);
  const trimmed = value.trim();
  if (required && !trimmed) fail(`${field} is empty`, field);
  if ([...trimmed].length > max) fail(`${field} is longer than ${max} characters`, field);
  if (CONTROL_CHARS.test(multiline ? trimmed.replace(/[\n\t]/g, '') : trimmed)) fail(`${field} contains control characters`, field);
  return trimmed;
};

const source = (value: unknown): NoteSource | null => {
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

// Checks what the renderer sends; the id and times are the store's own.
export const validateNote = (raw: unknown): NoteInput => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('A note must be an object', 'note');
  const input = raw as Record<string, unknown>;
  if (!CATEGORIES.includes((input.category ?? null) as GradeCategory | null)) fail('Unknown category', 'category');
  const tags = input.tags ?? [];
  if (!Array.isArray(tags) || tags.length > MAX_TAGS) fail(`tags must be a list of at most ${MAX_TAGS}`, 'tags');
  return {
    title: text(input.title, 'title', MAX_TITLE),
    body: text(input.body, 'body', MAX_BODY, { multiline: true, required: false }),
    category: (input.category ?? null) as GradeCategory | null,
    tags: [...new Set(tags.map((tag, index) => text(tag, `tags[${index}]`, MAX_TAG)))],
    source: source(input.source),
  };
};

export class NoteStore {
  #file: string;
  #notes = new Map<string, Note>();
  #writes: Promise<void> = Promise.resolve();
  #now: () => Date;

  constructor(configDir: string, { now = () => new Date() }: { now?: () => Date } = {}) {
    this.#file = path.join(configDir, NOTES_FILENAME);
    this.#now = now;
  }

  async load(): Promise<this> {
    try {
      const saved: unknown = JSON.parse(await fs.readFile(this.#file, 'utf8'));
      for (const note of (Array.isArray(saved) ? saved : []) as Note[]) {
        if (typeof note?.id === 'string' && typeof note.title === 'string') this.#notes.set(note.id, note);
      }
    } catch (error) {
      // A missing file is a first start. A corrupt one is kept for the
      // developer to recover rather than overwritten by the next save.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return this;
      if (error instanceof SyntaxError) {
        const aside = `${this.#file}.corrupt-${this.#now().getTime()}`;
        await fs.rename(this.#file, aside);
        console.error(`[notes] notes.json could not be read; kept it as ${path.basename(aside)}`, error);
        return this;
      }
      throw error;
    }
    return this;
  }

  flush(): Promise<void> {
    return this.#writes;
  }

  // Newest first.
  list(): Note[] {
    return [...this.#notes.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((note) => structuredClone(note));
  }

  get(id: string): Note {
    const note = this.#notes.get(id);
    if (!note) throw new NoteError(`Unknown note: ${id}`, 'unknown_note');
    return structuredClone(note);
  }

  async create(raw: unknown): Promise<Note> {
    const input = validateNote(raw);
    if (this.#notes.size >= MAX_NOTES) throw new NoteError(`At most ${MAX_NOTES} notes`, 'notes_full');
    const at = this.#now().toISOString();
    const note: Note = { id: randomUUID(), ...input, createdAt: at, updatedAt: at };
    this.#notes.set(note.id, note);
    await this.#persist();
    return structuredClone(note);
  }

  // Replaces the developer-editable fields; the source stays as recorded.
  async update(id: string, raw: unknown): Promise<Note> {
    const current = this.get(id);
    const input = validateNote({ ...(raw as object), source: current.source });
    const note: Note = { ...current, ...input, updatedAt: this.#now().toISOString() };
    this.#notes.set(id, note);
    await this.#persist();
    return structuredClone(note);
  }

  async remove(id: string): Promise<void> {
    this.get(id);
    this.#notes.delete(id);
    await this.#persist();
  }

  #persist(): Promise<void> {
    const write = this.#writes.then(async () => {
      await fs.mkdir(path.dirname(this.#file), { recursive: true });
      const tmp = `${this.#file}.tmp`;
      await fs.writeFile(tmp, `${JSON.stringify([...this.#notes.values()], null, 2)}\n`);
      await fs.rename(tmp, this.#file);
    });
    this.#writes = write.catch(() => {});
    return write;
  }
}
