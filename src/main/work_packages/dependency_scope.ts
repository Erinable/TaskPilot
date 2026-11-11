// A dependency manifest and the repository's existing npm lockfile are one
// change. Older Product Lead plans sometimes named only package.json, leaving
// Coding Agent unable to install a dependency while honoring the file scope.
import { lstatSync } from 'node:fs';
import path from 'node:path';

import type { TaskDefinition } from './tasks.ts';

const NPM_LOCKFILES = ['npm-shrinkwrap.json', 'package-lock.json'];

export const withDependencyScope = (task: TaskDefinition, root: string | null): TaskDefinition => {
  if (!root || !task.fileScope.includes('package.json')) return task;
  const companions = NPM_LOCKFILES.filter((file) => {
    if (task.fileScope.includes(file)) return false;
    try {
      // A symlink must not grant access to another file. The patch writer
      // still enforces its scope, secret and high-risk boundaries as usual.
      return lstatSync(path.join(root, file)).isFile();
    } catch {
      return false;
    }
  });
  return companions.length ? { ...task, fileScope: [...task.fileScope, ...companions] } : task;
};
