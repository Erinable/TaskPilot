// Pure logic of the notes page: filtering, link resolution, backlinks,
// [[ completion and the labels it shows.
import { businessDay, businessTimeZone } from '@/lib/time_zone.ts';
import { COURSE_DIMENSIONS, COURSE_DIMENSION_LABELS, PROGRAMMING_COURSE } from '@shared/course_pack.ts';
import * as markdown from '@shared/note_markdown.ts';
import * as noteCourses from '@shared/note_courses.ts';
import type { CourseDimension } from '@shared/course_pack.ts';
import type * as noteTypes from '@shared/ipc/notes.ts';

// One rubric item of one pack, or a dimension across every pack.
export type CategoryFilter = { course: string; category: string } | { dimension: CourseDimension };
export type NoteFilter = { query: string; category: CategoryFilter | null; tag: string | null };

// What the page knows before the main process answers: only the built-in programming pack.
export const DEFAULT_COURSES: noteTypes.NoteCourses = {
  current: PROGRAMMING_COURSE.id,
  packs: [{ id: PROGRAMMING_COURSE.id, title: PROGRAMMING_COURSE.title, rubric: PROGRAMMING_COURSE.rubric }],
};

export const currentPack = (courses: noteTypes.NoteCourses) => courses.packs.find((pack) => pack.id === courses.current)!;

// The rubric item's label in the note's pack; a category no known pack has
// is shown as written.
// [人工决策-2026-10-26 15:38:21] 不认识的维度显示原 id 加「未知维度」，不报错。
export const categoryLabel = (note: Pick<noteTypes.NoteMeta, 'category' | 'course'>, courses: noteTypes.NoteCourses): string | null => {
  if (note.category === null) return null;
  const item = noteCourses.rubricItemOf(note, courses.packs);
  if (item) return item.label;
  return noteCourses.isDimension(note.category) ? COURSE_DIMENSION_LABELS[note.category] : `${note.category}（未知维度）`;
};

export const categoryFilterOf = (note: Pick<noteTypes.NoteMeta, 'category' | 'course'>): CategoryFilter | null =>
  note.category === null ? null : { course: noteCourses.noteCourseId(note), category: note.category };

export const filterLabel = (filter: CategoryFilter, courses: noteTypes.NoteCourses) =>
  'dimension' in filter ? `${COURSE_DIMENSION_LABELS[filter.dimension]}（通用维度）` : categoryLabel(filter, courses)!;

const matchesCategory = (note: noteTypes.NoteMeta, filter: CategoryFilter, courses: noteTypes.NoteCourses) =>
  'dimension' in filter
    ? noteCourses.dimensionOf(note, courses.packs) === filter.dimension
    : note.category === filter.category && noteCourses.noteCourseId(note) === filter.course;

export const allTags = (note: noteTypes.NoteMeta) => [...new Set([...note.tags, ...note.inlineTags])];

// Search matches the title, tags, excerpt and source here, plus the bodies
// the main process found (bodyMatches), case-insensitively.
export const filterNotes = (
  notes: noteTypes.NoteMeta[],
  { query, category, tag }: NoteFilter,
  courses: noteTypes.NoteCourses,
  bodyMatches: Set<string> = new Set(),
): noteTypes.NoteMeta[] => {
  const needle = query.trim().toLowerCase();
  return notes.filter((note) => {
    if (category && !matchesCategory(note, category, courses)) return false;
    if (tag && !allTags(note).includes(tag)) return false;
    if (!needle || bodyMatches.has(note.id)) return true;
    const haystack = [note.title, note.excerpt, note.summary, ...allTags(note), note.source?.packageTitle, note.source?.file, note.source?.repositoryName]
      .filter(Boolean)
      .join('\n');
    return haystack.toLowerCase().includes(needle);
  });
};

// "项目 · 工作包 · 文件:行", leaving out what is unknown.
export const sourceLabel = (source: noteTypes.NoteSource | null): string | null => {
  if (!source) return null;
  const location = source.file ? (source.line ? `${source.file}:${source.line}` : source.file) : null;
  const parts = [source.repositoryName, source.packageTitle, location].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
};

// Title (any case) → note, for resolving [[links]].
export const titleIndex = (notes: noteTypes.NoteMeta[]) => new Map(notes.map((note) => [markdown.titleKey(note.title), note]));

// Notes that link to this one, newest first.
export const backlinks = (notes: noteTypes.NoteMeta[], note: noteTypes.NoteMeta): noteTypes.NoteMeta[] => {
  const key = markdown.titleKey(note.title);
  return notes.filter((other) => other.id !== note.id && other.links.some((link) => markdown.titleKey(link) === key));
};

// Notes that link to a title, for the rename dialog.
export const linkingCount = (notes: noteTypes.NoteMeta[], title: string, selfId: string) => {
  const key = markdown.titleKey(title);
  return notes.filter((other) => other.id !== selfId && other.links.some((link) => markdown.titleKey(link) === key)).length;
};

// An open [[ before the cursor on the same line: what has been typed after it.
export const linkQueryAt = (text: string, cursor: number): { start: number; query: string } | null => {
  const before = text.slice(0, cursor);
  const open = before.lastIndexOf('[[');
  if (open === -1) return null;
  const typed = before.slice(open + 2);
  if (/[\]\n|#]/.test(typed) || typed.length > markdown.MAX_TITLE) return null;
  return { start: open, query: typed };
};

// Up to `limit` titles for [[ completion: prefix matches first, then the rest.
export const linkSuggestions = (notes: noteTypes.NoteMeta[], query: string, selfId: string | null, limit = 8): noteTypes.NoteMeta[] => {
  const needle = query.trim().toLowerCase();
  const candidates = notes.filter((note) => note.id !== selfId && note.title.toLowerCase().includes(needle));
  const prefix = candidates.filter((note) => note.title.toLowerCase().startsWith(needle));
  return [...prefix, ...candidates.filter((note) => !prefix.includes(note))].slice(0, limit);
};

// The editor text with [[query replaced by a finished [[title]].
export const completeLink = (text: string, start: number, cursor: number, title: string) => {
  const after = text.slice(cursor);
  const closing = after.startsWith(']]') ? '' : ']]';
  const inserted = `[[${title}${closing}`;
  return { text: `${text.slice(0, start)}${inserted}${after}`, cursor: start + inserted.length + (closing ? 0 : 2) };
};

// YYYY-MM-DD of an ISO time, in the business time zone.
export const formatDay = (iso: string, timeZone = businessTimeZone()) => businessDay(new Date(iso), timeZone);

// Notes by the month they were written, newest first, as a blog archive
// lists posts.
export const groupByMonth = (notes: noteTypes.NoteMeta[], timeZone = businessTimeZone()) => {
  const groups = new Map<string, noteTypes.NoteMeta[]>();
  for (const note of [...notes].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    const month = formatDay(note.createdAt, timeZone).slice(0, 7);
    groups.set(month, [...(groups.get(month) ?? []), note]);
  }
  return [...groups].map(([month, entries]) => ({ month, label: `${month.slice(0, 4)} 年 ${Number(month.slice(5, 7))} 月`, notes: entries }));
};

// Tags with how many notes carry them, most used first.
export const tagCounts = (notes: noteTypes.NoteMeta[]) => {
  const counts = new Map<string, number>();
  for (const note of notes) for (const tag of allTags(note)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  return [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
};

// The pack in use's rubric items with how many of its notes carry each.
export const rubricCounts = (notes: noteTypes.NoteMeta[], courses: noteTypes.NoteCourses) => {
  const pack = currentPack(courses);
  return pack.rubric.map((item) => ({
    filter: { course: pack.id, category: item.id },
    label: item.label,
    count: notes.filter((note) => note.category === item.id && noteCourses.noteCourseId(note) === pack.id).length,
  }));
};

// The shared dimensions with how many notes of every pack map onto each.
export const dimensionCounts = (notes: noteTypes.NoteMeta[], courses: noteTypes.NoteCourses) =>
  COURSE_DIMENSIONS.map((dimension) => ({
    filter: { dimension },
    label: COURSE_DIMENSION_LABELS[dimension],
    count: notes.filter((note) => noteCourses.dimensionOf(note, courses.packs) === dimension).length,
  }));

// The dimensions only say something the rubric does not when the pack's
// items are not the dimensions themselves, or some notes are of another pack.
export const showDimensions = (notes: noteTypes.NoteMeta[], courses: noteTypes.NoteCourses) =>
  currentPack(courses).rubric.some((item) => item.id !== item.dimension) ||
  notes.some((note) => note.category && noteCourses.noteCourseId(note) !== courses.current);

// The editor's category choices: the rubric of the note's pack when it is
// known here (a note with neither category nor course is new to the pack in
// use), else of the pack in use, plus the note's own category when neither
// has it, so it is never dropped by opening the editor. `course` is the pack
// a picked category belongs to.
export const categoryOptions = (draft: { category: string | null; course: string | null }, courses: noteTypes.NoteCourses) => {
  const own = draft.category === null && draft.course === null ? null : courses.packs.find((entry) => entry.id === noteCourses.noteCourseId(draft));
  const pack = own ?? currentPack(courses);
  const options = pack.rubric.map((item) => ({ value: item.id, label: item.label }));
  if (draft.category !== null && !options.some((option) => option.value === draft.category))
    options.push({ value: draft.category, label: categoryLabel(draft, courses)! });
  return { course: pack.id, options };
};

// How the editor lays out Markdown and its preview, as in Obsidian / VS Code:
// source only, side by side, or the rendered page only.
export type EditorMode = 'source' | 'split' | 'preview';
export const EDITOR_MODES: { value: EditorMode; label: string }[] = [
  { value: 'source', label: '源码' },
  { value: 'split', label: '分栏' },
  { value: 'preview', label: '预览' },
];
export const EDITOR_MODE_STORAGE_KEY = 'taskpilot.noteEditorMode';

// The remembered mode; anything unreadable is side by side.
export const readEditorMode = (storage: Pick<Storage, 'getItem'> | undefined): EditorMode => {
  const stored = storage?.getItem(EDITOR_MODE_STORAGE_KEY);
  return EDITOR_MODES.some((mode) => mode.value === stored) ? (stored as EditorMode) : 'split';
};

// ⌘E steps source → split → preview → source.
export const nextEditorMode = (mode: EditorMode): EditorMode =>
  EDITOR_MODES[(EDITOR_MODES.findIndex((entry) => entry.value === mode) + 1) % EDITOR_MODES.length].value;
