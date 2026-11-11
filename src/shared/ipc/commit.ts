// Committing an accepted package (commit:*).
import { invoke } from './contract.ts';
import type { Contract } from './contract.ts';

export type CommitSkipReason = 'out_of_scope' | 'secret' | 'rename';

// What committing a finished package would include, from git status.
export type CommitPreview = {
  // Inside the package's file scope; committed as listed.
  files: string[];
  // Companion project files outside the scope: taskpilot.toml, and npm
  // lockfiles when the package owns package.json. Included only when ticked.
  optional: string[];
  // Held back; the developer commits these by hand if they mean to.
  skipped: { path: string; reason: CommitSkipReason }[];
  // Suggested message; the developer may edit it.
  message: string;
};

export type CommitResult = { commit: string; files: string[] };

export const commitContract = {
  preview: invoke<[id: string], CommitPreview>('commit:preview'),
  // `files` is the list the developer reviewed; a changed list is refused.
  // `extra` are the optional files they ticked.
  create: invoke<[id: string, message: string, files: string[], extra?: string[]], CommitResult>('commit:create'),
} satisfies Contract;
