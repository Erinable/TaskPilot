// Pure logic of the notes page: filtering and the labels it shows.
import type * as ipc from '@shared/ipc_types.ts';

export type NoteFilter = { query: string; category: ipc.GradeCategory | null; tag: string | null };

export const CATEGORY_LABELS: Record<ipc.GradeCategory, string> = { thinking: '思路', writing: '写法', style: '风格' };

// Search matches the title, body, tags and where the note came from, case-insensitively.
export const filterNotes = (notes: ipc.Note[], { query, category, tag }: NoteFilter): ipc.Note[] => {
  const needle = query.trim().toLowerCase();
  return notes.filter((note) => {
    if (category && note.category !== category) return false;
    if (tag && !note.tags.includes(tag)) return false;
    if (!needle) return true;
    const haystack = [note.title, note.body, ...note.tags, note.source?.packageTitle, note.source?.file, note.source?.repositoryName]
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
