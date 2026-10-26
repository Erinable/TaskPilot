// Course pack channels: the packs a repository can teach with, their full
// content, picking one on this machine and importing a pack file into the
// global folder (courses:*). Confirming the pack in use is workspace:confirm-course.

import type { CourseChange } from '../course_changes.ts';
import type { CoursePack, CourseRef, CourseSource } from '../course_pack.ts';
import type { CourseView } from './workspace.ts';

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
