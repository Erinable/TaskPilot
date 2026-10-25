// Committing an accepted package (commit:*).

export type CommitSkipReason = 'out_of_scope' | 'secret' | 'rename';

// What committing a finished package would include, from git status.
export type CommitPreview = {
  // Inside the package's file scope; committed as listed.
  files: string[];
  // Held back; the developer commits these by hand if they mean to.
  skipped: { path: string; reason: CommitSkipReason }[];
  // Suggested message; the developer may edit it.
  message: string;
};

export type CommitResult = { commit: string; files: string[] };
