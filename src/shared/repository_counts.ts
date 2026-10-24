// Work waiting in a repository, as the sidebar's project list shows it.
// Shared so the open repository's live queue and the main process's counts
// for closed ones use the same buckets.
import type { RepositoryCounts, WorkPackageStatus } from './ipc_types.ts';

// in_review, deviation and blocked are being worked on too, just not by hand.
const ACTIVE: WorkPackageStatus[] = ['in_progress', 'in_review', 'deviation', 'blocked'];

export const countStatuses = (statuses: WorkPackageStatus[]): RepositoryCounts => ({
  pending: statuses.filter((status) => status === 'pending').length,
  active: statuses.filter((status) => ACTIVE.includes(status)).length,
  accepting: statuses.filter((status) => status === 'accepting').length,
});
