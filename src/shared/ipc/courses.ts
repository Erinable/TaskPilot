// Course pack channels: the packs a repository can teach with, their full
// content, picking one on this machine, importing a pack file into the
// global folder, and copying a pack there to edit it (courses:*). Confirming the pack in use is workspace:confirm-course.

import type { CourseChange } from '../course_changes.ts';
import type { CoursePack, CourseRef, CourseSource } from '../course_pack.ts';
import type { CourseView } from './workspace.ts';
import { invoke } from './contract.ts';
import type { Contract } from './contract.ts';

// `builtin` needs no confirmation; `pending` is a repository or imported
// pack this machine has not confirmed at its current content.
export type CourseTrust = 'builtin' | 'confirmed' | 'pending' | 'invalid';

export type CourseEntry = {
  id: string;
  source: CourseSource;
  // Null when the file does not validate; `error` then says why.
  title: string | null;
  version: string | null;
  // The pack's appliesTo.languages; null when it names none.
  languages: string[] | null;
  trust: CourseTrust;
  error: string | null;
};

export type CourseList = {
  // How the repository's choice resolved, as workspace:get reports it.
  current: CourseView;
  entries: CourseEntry[];
  // The open repository's language ids (presets), to warn when a pack's
  // appliesTo.languages names none of them; empty when unknown.
  languages: string[];
  // The global folder imported packs are copied to.
  userDir: string;
};

// A pack's full content. `previous` says what this machine confirmed
// before: `none`, a content it still has (`changes` lists the differences),
// or only a hash (`unknown`, from before contents were kept).
export type CoursePreview = {
  pack: CoursePack;
  ref: CourseRef;
  trust: Exclude<CourseTrust, 'invalid'>;
  previous: 'none' | 'known' | 'unknown';
  changes: CourseChange[];
};

// courses:pick-import: a validated file, not yet copied. `changes` are
// against what this machine confirmed for an imported pack of that id;
// `replaces` when one is already imported; `shadowed` when the open
// repository has its own pack of that id, which wins there.
export type CourseImport = CoursePreview & { replaces: boolean; shadowed: boolean };

// courses:copy and courses:save: the list after the write, and the pack
// written, previewed as it now stands (a saved pack is pending until this
// machine confirms it again).
export type CourseSaved = { list: CourseList; preview: CoursePreview };

export const coursesContract = {
  list: invoke<[], CourseList>('courses:list'),
  preview: invoke<[id: string], CoursePreview>('courses:preview'),
  // Writes this machine's choice; null leaves it to taskpilot.toml.
  select: invoke<[id: string | null], CourseList>('courses:select'),
  // Opens the file picker and validates the file; nothing is copied yet.
  pickImport: invoke<[], CourseImport | null>('courses:pick-import'),
  // Copies the picked file, the content with the hash shown, into the global folder.
  import: invoke<[contentHash: string], CourseList>('courses:import'),
  // The built-in default pack, for records from before packs.
  default: invoke<[], CoursePack>('courses:default'),
  // Copies a pack into the global folder as `id`; the copy needs confirming.
  copy: invoke<[sourceId: string, id: string], CourseSaved>('courses:copy'),
  // Saves an imported or copied pack from the editor; it needs confirming again.
  save: invoke<[id: string, pack: CoursePack], CourseSaved>('courses:save'),
} satisfies Contract;
