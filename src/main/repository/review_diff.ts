// Collects a work package's changes for QA to review, within a fixed boundary.
//
// SECURITY: this is the only place QA-bound diff contents come from. Unlike
// ./repo_reader.js it has to read the working tree, because the work under
// review is uncommitted and often untracked. To keep that safe:
//   - only paths git itself reports as changed since the baseline are read;
//   - every path must resolve inside the workspace root;
//   - secret-looking paths are refused before anything is read, using the
//     same patterns as repo_reader.js;
//   - binary changes, oversized patches and totals past the budget are skipped.
// Every skip is reported so QA (and the user) know what was not reviewed.
import * as git from './git.ts';
import { looksSecret } from './repo_reader.ts';
import { isInside } from './workspace.ts';

export const DEFAULT_LIMITS = { maxFiles: 20, maxPatchBytes: 32 * 1024, maxTotalBytes: 160 * 1024 };

export type DiffLimits = typeof DEFAULT_LIMITS;

// One changed file's patch for QA.
export interface DiffFile {
  path: string;
  patch: string;
  bytes: number;
  untracked: boolean;
}

export type DiffSkipReason = 'rename' | 'outside_workspace' | 'secret' | 'binary' | 'file_limit' | 'unreadable' | 'too_large' | 'budget';

export interface DiffSkip {
  path: string;
  reason: DiffSkipReason;
}

export interface CollectedDiff {
  changes: git.FileChange[];
  files: DiffFile[];
  skipped: DiffSkip[];
}

export interface CollectOptions {
  limits?: Partial<DiffLimits>;
  prioritize?: (path: string) => boolean;
  changes?: git.FileChange[];
  ignore?: (path: string) => boolean;
}

// root: workspace root (a git top level)
// baseline: commit recorded when the package was claimed
// options.prioritize: optional (path) => boolean; matching files are
//   read first, so the budget goes to the files the package was meant to touch
// options.changes: optional precomputed git.changesSince() result
export const collectChanges = async (
  root: string,
  baseline: string,
  { limits = {}, prioritize = () => false, changes, ignore = () => false }: CollectOptions = {},
): Promise<CollectedDiff> => {
  const { maxFiles, maxPatchBytes, maxTotalBytes } = { ...DEFAULT_LIMITS, ...limits };
  // `ignore` drops files TaskPilot's own checks produced (test reports), so
  // they are neither reviewed nor counted as the package's changes.
  const all = (changes ?? (await git.changesSince(root, baseline))).filter((c) => !ignore(c.path));
  // Stable: preferred files first, otherwise git's order.
  const ordered = [...all.filter((c) => prioritize(c.path)), ...all.filter((c) => !prioritize(c.path))];
  const files: DiffFile[] = [];
  const skipped: DiffSkip[] = [];
  let total = 0;

  for (const change of ordered) {
    const skip = (reason: DiffSkipReason) => skipped.push({ path: change.path, reason });
    // Renames are reported as "old → new" by git.status(); there is no single
    // path to read, so they are listed rather than diffed.
    if (change.path.includes(' → ')) {
      skip('rename');
      continue;
    }
    if (!isInside(root, change.path)) {
      skip('outside_workspace');
      continue;
    }
    if (looksSecret(change.path)) {
      skip('secret');
      continue;
    }
    if (change.binary) {
      skip('binary');
      continue;
    }
    if (files.length >= maxFiles) {
      skip('file_limit');
      continue;
    }

    let patch;
    try {
      patch = await git.diffFile(root, baseline, change.path);
    } catch {
      skip('unreadable');
      continue;
    }
    const bytes = Buffer.byteLength(patch);
    if (bytes > maxPatchBytes) {
      skip('too_large');
      continue;
    }
    if (total + bytes > maxTotalBytes) {
      skip('budget');
      continue;
    }
    total += bytes;
    files.push({ path: change.path, patch, bytes, untracked: change.untracked === true });
  }
  return { changes: all, files, skipped };
};
