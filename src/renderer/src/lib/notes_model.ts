// Pure logic of the notes page: filtering, link resolution, backlinks,
// [[ completion and the labels it shows.
import { businessDay, businessTimeZone } from '@/lib/time_zone.ts';
import * as markdown from '@shared/note_markdown.ts';
import type * as ipc from '@shared/ipc_types.ts';

export type NoteFilter = { query: string; category: ipc.GradeCategory | null; tag: string | null };

export const CATEGORY_LABELS: Record<ipc.GradeCategory, string> = { thinking: '思路', writing: '写法', style: '风格' };

export const allTags = (note: ipc.NoteMeta) => [...new Set([...note.tags, ...note.inlineTags])];

// Search matches the title, tags, excerpt and source here, plus the bodies
// the main process found (bodyMatches), case-insensitively.
export const filterNotes = (notes: ipc.NoteMeta[], { query, category, tag }: NoteFilter, bodyMatches: Set<string> = new Set()): ipc.NoteMeta[] => {
  const needle = query.trim().toLowerCase();
  return notes.filter((note) => {
    if (category && note.category !== category) return false;
    if (tag && !allTags(note).includes(tag)) return false;
    if (!needle || bodyMatches.has(note.id)) return true;
    const haystack = [note.title, note.excerpt, note.summary, ...allTags(note), note.source?.packageTitle, note.source?.file, note.source?.repositoryName]
      .filter(Boolean)
      .join('\n');
    return haystack.toLowerCase().includes(needle);
  });
};

// "项目 · 工作包 · 文件:行", leaving out what is unknown.
export const sourceLabel = (source: ipc.NoteSource | null): string | null => {
  if (!source) return null;
  const location = source.file ? (source.line ? `${source.file}:${source.line}` : source.file) : null;
  const parts = [source.repositoryName, source.packageTitle, location].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
};

// Title (any case) → note, for resolving [[links]].
export const titleIndex = (notes: ipc.NoteMeta[]) => new Map(notes.map((note) => [markdown.titleKey(note.title), note]));

// Notes that link to this one, newest first.
export const backlinks = (notes: ipc.NoteMeta[], note: ipc.NoteMeta): ipc.NoteMeta[] => {
  const key = markdown.titleKey(note.title);
  return notes.filter((other) => other.id !== note.id && other.links.some((link) => markdown.titleKey(link) === key));
};

// Notes that link to a title, for the rename dialog.
export const linkingCount = (notes: ipc.NoteMeta[], title: string, selfId: string) => {
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
export const linkSuggestions = (notes: ipc.NoteMeta[], query: string, selfId: string | null, limit = 8): ipc.NoteMeta[] => {
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
export const groupByMonth = (notes: ipc.NoteMeta[], timeZone = businessTimeZone()) => {
  const groups = new Map<string, ipc.NoteMeta[]>();
  for (const note of [...notes].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    const month = formatDay(note.createdAt, timeZone).slice(0, 7);
    groups.set(month, [...(groups.get(month) ?? []), note]);
  }
  return [...groups].map(([month, entries]) => ({ month, label: `${month.slice(0, 4)} 年 ${Number(month.slice(5, 7))} 月`, notes: entries }));
};

// Tags with how many notes carry them, most used first.
export const tagCounts = (notes: ipc.NoteMeta[]) => {
  const counts = new Map<string, number>();
  for (const note of notes) for (const tag of allTags(note)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  return [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
};

export const categoryCounts = (notes: ipc.NoteMeta[]) => {
  const counts: Partial<Record<ipc.GradeCategory, number>> = {};
  for (const note of notes) if (note.category) counts[note.category] = (counts[note.category] ?? 0) + 1;
  return counts;
};
