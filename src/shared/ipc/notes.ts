// Learning notes (notes:*).

import type { RubricItem } from '../course_pack.ts';
import type { GradeCategory } from './packages.ts';
import { invoke } from './contract.ts';
import type { Contract } from './contract.ts';

// Where a note came from; every part is optional (a hand-written note has none).
export type NoteSource = {
  repositoryId: string | null;
  repositoryName: string | null;
  packageId: string | null;
  packageTitle: string | null;
  file: string | null;
  line: number | null;
};
// A note is one Markdown file in the notes folder: the title is its file
// name, the body is Markdown, and the other fields live in its frontmatter.
// category: set when saved from a grade comment, or chosen by hand; a rubric
// item id of the note's course pack, kept as written even when no known pack
// has it.
// course: the pack the category belongs to; absent means programming (notes
// written before packs existed have none).
// concepts: concept ids of the course pack the note is about, carried over
// from the package when saved from a grade; empty on other notes.
// tags: the frontmatter list; #tags written in the body are inlineTags.
// summary: what Tutor reads when grading instead of the body, written on
// request (by Tutor or by hand); stale once the body changed after it.
export type NoteInput = {
  title: string;
  body: string;
  category: GradeCategory | null;
  course?: string | null;
  concepts?: string[];
  tags: string[];
  source: NoteSource | null;
};
export type NoteEdit = {
  title: string;
  body: string;
  category: GradeCategory | null;
  // Left out to keep the saved one.
  course?: string | null;
  // Left out to keep the saved ones.
  concepts?: string[];
  tags: string[];
  // Left out to keep the saved one; null removes it.
  summary?: string | null;
  // The version the edit started from; a different file on disk is a conflict.
  baseVersion: string;
  // Overwrite even when the file changed on disk since baseVersion.
  force?: boolean;
  // Point [[old title]] in other notes at the new title.
  renameLinks?: boolean;
};
// Everything but the body; the list holds every note.
export type NoteMeta = {
  id: string;
  title: string;
  category: GradeCategory | null;
  course: string | null;
  concepts: string[];
  tags: string[];
  inlineTags: string[];
  source: NoteSource | null;
  summary: string | null;
  summaryStale: boolean;
  // Titles this note links to with [[ ]], as written (first spelling wins).
  links: string[];
  excerpt: string;
  createdAt: string;
  updatedAt: string;
  // Digest of the file; changes whenever the file does.
  version: string;
  // The frontmatter is not valid YAML: the note can be read, not saved here.
  frontmatterError: boolean;
};
export type Note = NoteMeta & { body: string };
// revision: bumps on every change, ours or another program's.
// unavailable: the chosen folder that could not be opened (the default one is open instead).
// truncated: the folder holds more notes than TaskPilot reads.
export type NoteList = { revision: number; directory: string; custom: boolean; unavailable: string | null; truncated: boolean; notes: NoteMeta[] };
export type NoteSaved = { revision: number; note: Note; relinked: number };
// The packs whose categories the notes page can name: the built-in ones and
// the one the open repository uses (`current`).
export type NoteCourse = { id: string; title: string; rubric: Pick<RubricItem, 'id' | 'label' | 'dimension'>[] };
export type NoteCourses = { current: string; packs: NoteCourse[] };

export const notesContract = {
  // Every note without its body; `since` returns null when nothing changed.
  list: invoke<[since: number | null], NoteList | null>('notes:list'),
  get: invoke<[id: string], Note>('notes:get'),
  // Ids of notes whose title, tags or body contain the query.
  search: invoke<[query: string], string[]>('notes:search'),
  // autoRename: a taken title gets a number instead of being refused.
  create: invoke<[input: NoteInput, autoRename: boolean], NoteSaved>('notes:create'),
  // The source stays as recorded; only the developer's text changes.
  update: invoke<[id: string, edit: NoteEdit], NoteSaved>('notes:update'),
  // Moves the file to the system trash.
  remove: invoke<[id: string], boolean>('notes:delete'),
  // Tutor writes the note's summary (costs a model call).
  summarize: invoke<[id: string, baseVersion: string], NoteSaved>('notes:summarize'),
  // null goes back to the default folder; files are never moved.
  setDirectory: invoke<[directory: string | null], NoteList>('notes:set-directory'),
  pickDirectory: invoke<[], string | null>('notes:pick-directory'),
  reveal: invoke<[], boolean>('notes:reveal'),
  // http(s) and mailto links only, opened by the system.
  openUrl: invoke<[url: string], boolean>('notes:open-url'),
  // The packs whose categories the notes page names, and the one in use.
  courses: invoke<[], NoteCourses>('notes:courses'),
} satisfies Contract;
