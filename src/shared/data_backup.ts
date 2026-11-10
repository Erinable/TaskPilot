export type BackupPreview = {
  id: string;
  path: string;
  createdAt: string;
  appVersion: string | null;
  files: number;
  bytes: number;
  externalNotes: string | null;
  drafts: number;
};

export type BackupResult = Omit<BackupPreview, 'id'>;
export type RestorePrepared = { restartRequired: true; rollbackPath: string };
export type RestoredDrafts = { token: string; entries: Record<string, string> };
