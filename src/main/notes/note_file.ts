import { createHash } from 'node:crypto';
import YAML from 'yaml';

import * as markdown from '../../shared/note_markdown.ts';
import { DEFAULT_COURSE_ID, isCourseId } from '../../shared/course_pack.ts';
import { CONTROL_CHARS } from '../../shared/text_rules.ts';
import { isLabConcept } from '../repository/project_config.ts';
import type * as noteTypes from '../../shared/ipc/notes.ts';
import type { ErrorCode } from '../../shared/error_codes.ts';
import type { GradeCategory } from '../../shared/ipc/packages.ts';

const MAX_SUMMARY = 300;
const EXCERPT_LENGTH = 300;
const MAX_TAGS = 8;
const MAX_CONCEPTS = 8;
const MAX_TAG = 20;
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

export class NoteError extends Error {
  code: ErrorCode;
  field: string | undefined;
  constructor(message: string, code: ErrorCode, field?: string) {
    super(message);
    this.name = 'NoteError';
    this.code = code;
    this.field = field;
  }
}

export const fail: (message: string, field: string) => never = (message, field) => {
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
export const title = (value: unknown): string => {
  if (typeof value !== 'string') fail('title must be text', 'title');
  const problem = markdown.titleProblem(value.trim());
  if (problem) fail(problem, 'title');
  return value.trim();
};
export const body = (value: unknown): string => {
  if (typeof value !== 'string') fail('body must be text', 'body');
  if (CONTROL_CHARS.test(value)) fail('body contains control characters', 'body');
  return value;
};
const category = (value: unknown): GradeCategory | null => {
  if (value !== null && value !== undefined && !isCourseId(value)) fail('category must be a rubric item id', 'category');
  return (value ?? null) as GradeCategory | null;
};
const course = (value: unknown): string | null => {
  if (value !== null && value !== undefined && !isCourseId(value)) fail('course must be a course pack id', 'course');
  return (value ?? null) as string | null;
};
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
export const summary = (value: unknown): string | null => (value === null ? null : text(value, 'summary', MAX_SUMMARY));

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

export const digest = (content: string) => createHash('sha256').update(content).digest('hex').slice(0, 16);
export const fileName = (noteTitle: string) => `${noteTitle}.md`;

type Parsed = { doc: YAML.Document | null; head: string; body: string; frontmatterError: boolean };
const parseFile = (raw: string): Parsed => {
  const match = FRONTMATTER.exec(raw);
  if (!match) return { doc: null, head: '', body: raw, frontmatterError: false };
  const doc = YAML.parseDocument(match[1]);
  const valid = doc.errors.length === 0 && (doc.contents === null || YAML.isMap(doc.contents));
  return { doc: valid ? doc : null, head: match[0], body: raw.slice(match[0].length), frontmatterError: !valid };
};
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

export type Entry = { meta: noteTypes.NoteMeta; body: string; doc: YAML.Document | null; head: string };
export const toEntry = (id: string, raw: string, stat: { birthtime: Date; mtime: Date }): Entry => {
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

export type Fields = {
  category?: GradeCategory | null;
  course?: string | null;
  concepts?: string[];
  tags?: string[];
  source?: noteTypes.NoteSource | null;
  summary?: string | null;
  created?: string;
};
export const render = (doc: YAML.Document | null, noteBody: string, fields: Fields): string => {
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
export const editedFields = (input: Record<string, unknown>): Fields => {
  const fields: Fields = { category: category(input.category), tags: tags(input.tags) };
  if (input.course !== undefined) fields.course = course(input.course);
  if (input.concepts !== undefined) fields.concepts = concepts(input.concepts);
  if (input.summary !== undefined) fields.summary = summary(input.summary);
  return fields;
};
export const changedFields = ({ category: nextCategory, course: nextCourse, ...rest }: Fields, meta: noteTypes.NoteMeta): Fields => {
  const fields: Fields = rest;
  const courseOf = (value: string | null) => value ?? DEFAULT_COURSE_ID;
  if (nextCategory !== meta.category) fields.category = nextCategory;
  if (nextCourse !== undefined && courseOf(nextCourse) !== courseOf(meta.course)) fields.course = nextCourse;
  return fields;
};
