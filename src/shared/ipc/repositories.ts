// The repository registry and the work a switch would cancel (repositories:*).

export type Repository = {
  id: string;
  root: string;
  // Directory name, for display.
  name: string;
  lastOpenedAt: string;
  current: boolean;
  // The root no longer holds a git repository (moved, renamed or deleted).
  missing: boolean;
  // Work waiting in it; null when its saved data could not be read.
  counts: RepositoryCounts | null;
};

// active: in progress, in review, in deviation or blocked.
export type RepositoryCounts = { pending: number; active: number; accepting: number };

export type RepositoryList = { repositories: Repository[]; current: string | null };

// Background work a switch would cancel.
export type BusyKind = 'requirement' | 'review' | 'adjudication' | 'baseline' | 'release' | 'environment' | 'tutor' | 'coding' | 'reference' | 'grade';
export type BusyRun = { kind: BusyKind; label: string | null };
