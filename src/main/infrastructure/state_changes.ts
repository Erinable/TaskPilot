import { logger } from './logger.ts';
import type { StateChange, StateDomain } from '../../shared/ipc/state.ts';

export type StateChangeListener = (change: StateChange) => void;
export type StateChanged = (...domains: StateDomain[]) => void;

// State writes often arrive in a burst (for example, one coding event updates
// several fields). Keep one notification per domain and repository per turn,
// while taking the repository snapshot at the call site: a later repository
// switch must never relabel a queued event.
export const createStateChangeEmitter = (listener: StateChangeListener | undefined, repositoryId: () => string | null): StateChanged => {
  const pending = new Map<string, Set<StateDomain>>();
  let queued = false;
  const flush = () => {
    queued = false;
    const changes = [...pending.entries()];
    pending.clear();
    for (const [key, domains] of changes) {
      try {
        listener?.({ repositoryId: key === '\u0000' ? null : key, domains: [...domains] });
      } catch (error) {
        logger.error('[state] change listener failed', error);
      }
    }
  };

  return (...domains: StateDomain[]) => {
    if (!listener || !domains.length) return;
    const id = repositoryId();
    const key = id ?? '\u0000';
    const set = pending.get(key) ?? new Set<StateDomain>();
    for (const domain of domains) set.add(domain);
    pending.set(key, set);
    if (!queued) {
      queued = true;
      queueMicrotask(flush);
    }
  };
};
