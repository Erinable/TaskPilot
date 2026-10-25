// Release Manager's drafts, releases and milestones (release:*, milestone:*).

import type { ErrorInfo } from './envelope.ts';

export type ReleaseBump = 'major' | 'minor' | 'patch';

// Each group is a short list of lines in Simplified Chinese.
export type ReleaseNotes = { added: string[]; fixed: string[]; changed: string[]; notes: string[] };

// evidence: paths or short shas that appeared in the input.
export type ReleaseChecklistItem = { text: string; evidence: string[] };

export type ReleasePlan = {
  bump: ReleaseBump;
  reason: string;
  // package.json version at HEAD; null when absent or not semver.
  currentVersion: string | null;
  // Computed by TaskPilot from currentVersion and bump.
  nextVersion: string;
  notes: ReleaseNotes;
  checklist: ReleaseChecklistItem[];
};

// Where the next release starts: the last finished release, the newest tag
// reachable from HEAD, or nothing (the user picks a recent commit).
// commitCount/packageCount preview what a run would include: commits in
// start..HEAD (capped at 200, commitsTruncated past that) and done packages
// no earlier release included. Zero for 'none'. Optional so the change is
// additive; release:get always sets them.
type ReleasePreview = { commitCount?: number; commitsTruncated?: boolean; packageCount?: number };

export type ReleaseStartPoint =
  ({ kind: 'release' | 'tag'; commit: string; label: string } & ReleasePreview) | ({ kind: 'none'; commit: null; label: null } & ReleasePreview);

// What TaskPilot collected for the run, as counts for the page.
export type ReleaseInputSummary = {
  commitCount: number;
  commitsTruncated: boolean;
  fileCount: number;
  filesTruncated: boolean;
  packageIds: string[];
};

export type ReleaseDraftStatus = 'generating' | 'ready' | 'failed';

export type ReleaseDraft = {
  status: ReleaseDraftStatus;
  error: ErrorInfo | null;
  startCommit: string;
  // HEAD the draft was generated for.
  endCommit: string;
  input: ReleaseInputSummary | null;
  plan: ReleasePlan | null;
  // Editable Markdown body, generated from plan.notes.
  notesText: string;
  // Indices into plan.checklist the user has ticked.
  checked: number[];
  costUsd: number;
  startedAt: string;
  updatedAt: string;
};

export type Release = {
  id: string;
  version: string;
  startCommit: string;
  endCommit: string;
  notesText: string;
  checklist: (ReleaseChecklistItem & { checked: boolean })[];
  packageIds: string[];
  finishedAt: string;
};

// A version plan: the requirements a version is meant to ship.
export type Milestone = {
  id: string;
  version: string;
  // YYYY-MM-DD, optional.
  targetDate: string | null;
  requirementIds: string[];
  createdAt: string;
  // Set when a release of this version is finished.
  releasedAt: string | null;
};

// What the release page sends to create or edit a milestone.
export type MilestoneInput = { version: string; targetDate: string | null; requirementIds: string[] };

// A milestone with its requirements' progress, for the release page.
export type MilestoneView = Milestone & {
  requirements: { id: string; title: string; done: number; total: number }[];
  done: number;
  total: number;
  // Every package of every requirement is done.
  complete: boolean;
};

export type ReleaseState = {
  configured: boolean;
  draft: ReleaseDraft | null;
  // Open milestones first (by target date), then released ones.
  milestones: MilestoneView[];
  // Newest first, at most 50.
  history: Release[];
  // Null without a workspace.
  startPoint: ReleaseStartPoint | null;
  // A generation is running and can be cancelled.
  running: boolean;
};

export type ReleaseCommit = { sha: string; subject: string; date: string };

export type ReleaseDraftInput = { notes?: string; checked?: number[] };

// Relative to the workspace root, ending in .md.
export type ReleaseWriteInput = { path: string };

export type ReleaseWriteResult = { path: string };
