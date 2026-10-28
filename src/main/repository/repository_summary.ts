// How much work waits in each repository, for the sidebar's project list.
// The open repository is counted from memory; the others from their saved
// files, which do not change while they are closed (a switch cancels every
// background run). Reads only the two files the counts need.
import path from 'node:path';

import { readStoredJson } from '../infrastructure/persisted_json.ts';
import { logger } from '../infrastructure/logger.ts';
import { REQUIREMENTS_FILENAME } from '../requirements/requirement_store.ts';
import { STATE_FILENAME } from '../work_packages/work_package_store.ts';
import { countStatuses } from '../../shared/repository_counts.ts';
import type { WorkPackageStatus } from '../../shared/ipc/packages.ts';
import type { RepositoryCounts } from '../../shared/ipc/repositories.ts';

const readJson = async (file: string): Promise<unknown> => {
  try {
    return await readStoredJson(file, 1);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
};

// A closed repository's counts: every published package, with its saved
// status where there is one. Null when its files cannot be read.
export const readCounts = async (dataDir: string): Promise<RepositoryCounts | null> => {
  try {
    const requirementsRaw = await readJson(path.join(dataDir, REQUIREMENTS_FILENAME));
    const statesRaw = await readJson(path.join(dataDir, STATE_FILENAME));
    const savedValue =
      statesRaw && typeof statesRaw === 'object' && !Array.isArray(statesRaw) && 'version' in statesRaw && 'state' in statesRaw ? statesRaw.state : statesRaw;
    const saved = (savedValue && typeof savedValue === 'object' && !Array.isArray(savedValue) ? savedValue : {}) as Record<
      string,
      { status?: WorkPackageStatus } | null
    >;
    const requirementsValue =
      requirementsRaw && typeof requirementsRaw === 'object' && !Array.isArray(requirementsRaw) && 'version' in requirementsRaw && 'items' in requirementsRaw
        ? requirementsRaw.items
        : requirementsRaw;
    const packages = (Array.isArray(requirementsValue) ? requirementsValue : [])
      .filter((item) => item?.status === 'published' && Array.isArray(item.packages))
      .flatMap((item) => item.packages as { id: string; status: WorkPackageStatus }[]);
    return countStatuses(packages.map((pkg) => saved[pkg.id]?.status ?? pkg.status));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'unsupported_version') throw error;
    logger.error('[repositories] could not count work', error);
    return null;
  }
};
