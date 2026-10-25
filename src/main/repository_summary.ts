// How much work waits in each repository, for the sidebar's project list.
// The open repository is counted from memory; the others from their saved
// files, which do not change while they are closed (a switch cancels every
// background run). Reads only the two files the counts need.
import fs from 'node:fs/promises';
import path from 'node:path';

import { REQUIREMENTS_FILENAME } from './requirement_store.ts';
import { STATE_FILENAME } from './work_package_store.ts';
import { countStatuses } from '../shared/repository_counts.ts';
import type { WorkPackageStatus } from '../shared/ipc/packages.ts';
import type { RepositoryCounts } from '../shared/ipc/repositories.ts';

const readJson = async (file: string): Promise<unknown> => {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
};

// A closed repository's counts: every published package, with its saved
// status where there is one. Null when its files cannot be read.
export const readCounts = async (dataDir: string): Promise<RepositoryCounts | null> => {
  try {
    const requirements = await readJson(path.join(dataDir, REQUIREMENTS_FILENAME));
    const states = await readJson(path.join(dataDir, STATE_FILENAME));
    const saved = (states && typeof states === 'object' ? states : {}) as Record<string, { status?: WorkPackageStatus } | null>;
    const packages = (Array.isArray(requirements) ? requirements : [])
      .filter((item) => item?.status === 'published' && Array.isArray(item.packages))
      .flatMap((item) => item.packages as { id: string; status: WorkPackageStatus }[]);
    return countStatuses(packages.map((pkg) => saved[pkg.id]?.status ?? pkg.status));
  } catch (error) {
    console.error('[repositories] could not count work', error);
    return null;
  }
};
