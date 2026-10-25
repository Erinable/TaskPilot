// Background runs of the main process: every agent run, check run and setup
// step that outlives its IPC call registers here. A repository switch or quit
// cancels them all and waits for their last writes, and "who is busy" (the
// switch dialog, the team view) is read from the same entries.
import type { AgentId } from '../shared/agent_runtime.ts';
import type * as activityTypes from '../shared/ipc/activity.ts';
import type * as repositoryTypes from '../shared/ipc/repositories.ts';

// Registry kinds, in the order runs are listed.
const RUN_KINDS = [
  'requirement',
  'review',
  'adjudication',
  'baseline',
  'release',
  'environment',
  'tutor',
  'coding',
  'coding-checks',
  'reference',
  'grade',
  'note-summary',
] as const;
export type RunKind = (typeof RUN_KINDS)[number];

// Only kinds the team view knows can name an agent.
type Listing = { busy: repositoryTypes.BusyKind; agent?: undefined } | { busy: activityTypes.AgentWork['kind']; agent: () => AgentId };

export type RunInfo = Listing & {
  kind: RunKind;
  key: string;
  // Read when listed: a requirement's title can arrive while it runs. Null
  // when the run has no subject; the renderer words it by kind.
  label: () => string | null;
  // Listed once however many runs of this kind are in flight.
  once?: boolean;
};

type Entry = RunInfo & { controller: AbortController };

const entryKey = (kind: RunKind, key: string) => `${kind}\u0000${key}`;

export class BackgroundRuns {
  #entries = new Map<string, Entry>();
  #pending = new Set<Promise<unknown>>();

  // Registers a run and returns its controller. A run already registered
  // under the same kind and key is replaced; abort it first if it must stop.
  start(info: RunInfo): AbortController {
    const controller = new AbortController();
    this.#entries.set(entryKey(info.kind, info.key), { ...info, controller });
    return controller;
  }

  get(kind: RunKind, key: string): AbortController | undefined {
    return this.#entries.get(entryKey(kind, key))?.controller;
  }

  has(kind: RunKind, key: string): boolean {
    return this.#entries.has(entryKey(kind, key));
  }

  // Drops the run, unless a newer run has taken its place.
  finish(kind: RunKind, key: string, controller: AbortController): void {
    const id = entryKey(kind, key);
    if (this.#entries.get(id)?.controller === controller) this.#entries.delete(id);
  }

  // A promise to wait for before the stores may close.
  track(promise: Promise<unknown>): void {
    this.#pending.add(promise);
    promise.finally(() => this.#pending.delete(promise)).catch(() => {});
  }

  keys(kind: RunKind): string[] {
    return this.#list()
      .filter((entry) => entry.kind === kind)
      .map((entry) => entry.key);
  }

  // What cancelAll() would stop, named for the confirmation dialog.
  busy(): repositoryTypes.BusyRun[] {
    const listed = new Set<RunKind>();
    return this.#list().flatMap((entry): repositoryTypes.BusyRun[] => {
      if (entry.once && listed.has(entry.kind)) return [];
      listed.add(entry.kind);
      return [{ kind: entry.busy, label: entry.label() }];
    });
  }

  // The runs an agent of the team is busy with.
  work(): activityTypes.AgentWork[] {
    return this.#list().flatMap((entry): activityTypes.AgentWork[] => (entry.agent ? [{ agent: entry.agent(), kind: entry.busy, label: entry.label() }] : []));
  }

  // Aborts every run and waits for every tracked promise to settle.
  async cancelAll(): Promise<void> {
    for (const entry of this.#entries.values()) entry.controller.abort();
    await Promise.allSettled([...this.#pending]);
  }

  #list(): Entry[] {
    return [...this.#entries.values()].sort((left, right) => RUN_KINDS.indexOf(left.kind) - RUN_KINDS.indexOf(right.kind));
  }
}
