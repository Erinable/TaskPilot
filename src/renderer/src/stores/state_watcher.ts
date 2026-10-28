// One state:changed subscription with serialized reads, shared by the stores
// that follow main-process state: events for another repository or other
// domains are ignored, a change during a read queues exactly one more read,
// and invalidate()/stop() make every in-flight read stale.
import type { StateDomain } from '@shared/ipc/state.ts';
import { useRepositoryIdentityStore } from './repository_identity.ts';

export type StateWatcherOptions = {
  // Log prefix for a failed read.
  name: string;
  domains: StateDomain[];
  // isCurrent() turns false once the watcher is invalidated or stopped.
  read: (isCurrent: () => boolean) => Promise<void>;
  // Global data (notes) follows events from every repository.
  global?: boolean;
  // false: start() only subscribes and the store reads when it needs to.
  initialRead?: boolean;
  // Runs on every matching event, before the read.
  onChange?: () => void;
};

export const createStateWatcher = (options: StateWatcherOptions) => {
  let unsubscribe: (() => void) | null = null;
  let session = 0;
  let reading = false;
  let queued = false;

  const refresh = async (): Promise<void> => {
    if (reading) {
      queued = true;
      return;
    }
    const token = session;
    reading = true;
    try {
      await options.read(() => token === session);
    } finally {
      reading = false;
      if (queued) {
        queued = false;
        await refresh();
      }
    }
  };

  const logged = () => refresh().catch((error) => console.error(`[${options.name}] refresh failed`, error));

  // Subscribes once; every call reads again unless initialRead is false.
  const start = async () => {
    if (!unsubscribe) {
      const repositories = useRepositoryIdentityStore();
      unsubscribe = window.taskpilot.state.onChanged((change) => {
        if (!options.global && change.repositoryId !== repositories.currentId) return;
        if (!change.domains.some((domain) => options.domains.includes(domain))) return;
        options.onChange?.();
        logged();
      });
    }
    if (options.initialRead !== false) await logged();
  };

  // Keeps the subscription; reads already running are discarded.
  const invalidate = () => {
    session += 1;
    queued = false;
  };

  const stop = () => {
    invalidate();
    unsubscribe?.();
    unsubscribe = null;
  };

  return { start, stop, refresh, invalidate, active: () => !!unsubscribe, session: () => session };
};
