// Releases Release Manager prepared, and the one draft being prepared now.
//
// A draft moves generating → ready (plan shown, notes editable, checklist
// ticked) or failed; finishing a ready draft whose checklist is all ticked
// records it as a release and clears the draft. Only the newest
// MAX_HISTORY releases are kept, but every released package id is kept (one
// short string per package), so a package is never offered for a second
// release after its release has aged out of the history.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

import { formatNotes } from './agents/release_manager.ts';
import type { ReleasePlan } from './agents/release_manager.ts';
import type { ReleaseInputSummary } from '../shared/ipc_types.ts';
import { CONTROL_CHARS } from './text_rules.ts';

export const RELEASES_FILENAME = 'releases.json';
export const MAX_HISTORY = 50;
export const MAX_NOTES_TEXT = 20000;
const DRAFT_STATUSES = ['generating', 'ready', 'failed'] as const;
// Tabs and newlines are allowed in the Markdown body.

export type DraftStatus = (typeof DRAFT_STATUSES)[number];

export interface ReleaseDraft {
  status: DraftStatus;
  error: { code: string; message: string } | null;
  startCommit: string;
  endCommit: string;
  input: ReleaseInputSummary | null;
  plan: ReleasePlan | null;
  notesText: string;
  checked: number[];
  costUsd: number;
  startedAt: string;
  updatedAt: string;
}

export interface Release {
  id: string;
  version: string;
  startCommit: string;
  endCommit: string;
  notesText: string;
  checklist: { text: string; evidence: string[]; checked: boolean }[];
  packageIds: string[];
  finishedAt: string;
}

interface SavedState {
  draft: ReleaseDraft | null;
  history: Release[];
  releasedPackageIds: string[];
}

export type ReleaseErrorCode = 'invalid_argument' | 'invalid_state' | 'too_long' | 'invalid_text' | 'release_unchecked';

export class ReleaseError extends Error {
  code: ReleaseErrorCode;
  field?: string;

  constructor(message: string, code: ReleaseErrorCode, field?: string) {
    super(message);
    this.name = 'ReleaseError';
    this.code = code;
    if (field) this.field = field;
  }
}

const fail = (message: string, code: ReleaseErrorCode, field?: string): never => {
  throw new ReleaseError(message, code, field);
};

const isDraft = (value: unknown): value is ReleaseDraft => {
  const draft = value as ReleaseDraft | null | undefined;
  return Boolean(draft) && DRAFT_STATUSES.includes(draft!.status) && typeof draft!.startCommit === 'string' && typeof draft!.endCommit === 'string';
};

export class ReleaseStore {
  #file: string;
  #state: SavedState = { draft: null, history: [], releasedPackageIds: [] };
  #newId: () => string;
  #now: () => Date;

  constructor(
    configDir: string,
    { newId = () => `rel-${crypto.randomBytes(4).toString('hex')}`, now = () => new Date() }: { newId?: () => string; now?: () => Date } = {},
  ) {
    this.#file = path.join(configDir, RELEASES_FILENAME);
    this.#newId = newId;
    this.#now = now;
  }

  async load(): Promise<this> {
    try {
      const saved = JSON.parse(await fs.readFile(this.#file, 'utf8')) as Partial<SavedState> | null;
      const draft = isDraft(saved?.draft) ? saved.draft : null;
      // A run that was in flight when the app quit can't be resumed.
      if (draft?.status === 'generating') {
        draft.status = 'failed';
        draft.error = { code: 'agent_interrupted', message: 'TaskPilot 在 Release Manager 运行时退出了' };
      }
      this.#state = {
        draft,
        history: (Array.isArray(saved?.history) ? saved.history : []).filter((item) => typeof item?.id === 'string').slice(0, MAX_HISTORY),
        releasedPackageIds: (Array.isArray(saved?.releasedPackageIds) ? saved.releasedPackageIds : []).filter((id) => typeof id === 'string'),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    return this;
  }

  // Writes are chained so they never overlap (see requirement_store.ts).
  #writes: Promise<void> = Promise.resolve();

  #persist(): Promise<void> {
    const write = this.#writes.then(async () => {
      await fs.mkdir(path.dirname(this.#file), { recursive: true });
      const tmp = `${this.#file}.tmp`;
      await fs.writeFile(tmp, `${JSON.stringify(this.#state, null, 2)}\n`);
      await fs.rename(tmp, this.#file);
    });
    this.#writes = write.catch(() => {});
    return write;
  }

  #mustDraft(statuses: DraftStatus[]): ReleaseDraft {
    const draft = this.#state.draft;
    if (!draft || !statuses.includes(draft.status)) return fail('There is no release draft in that state', 'invalid_state');
    return draft;
  }

  async #setDraft(draft: ReleaseDraft | null): Promise<ReleaseDraft | null> {
    this.#state.draft = draft;
    await this.#persist();
    return structuredClone(draft);
  }

  draft(): ReleaseDraft | null {
    return structuredClone(this.#state.draft);
  }

  // Newest first.
  history(): Release[] {
    return structuredClone(this.#state.history);
  }

  latest(): Release | null {
    return structuredClone(this.#state.history[0] ?? null);
  }

  isReleased(packageId: string): boolean {
    return this.#state.releasedPackageIds.includes(packageId);
  }

  // Replaces any ready or failed draft; refuses while one is generating.
  async begin({ startCommit, endCommit }: { startCommit: string; endCommit: string }): Promise<ReleaseDraft> {
    if (this.#state.draft?.status === 'generating') fail('Release Manager is already running', 'invalid_state');
    const now = this.#now().toISOString();
    return (await this.#setDraft({
      status: 'generating',
      error: null,
      startCommit,
      endCommit,
      input: null,
      plan: null,
      notesText: '',
      checked: [],
      costUsd: 0,
      startedAt: now,
      updatedAt: now,
    }))!;
  }

  async complete(plan: ReleasePlan, input: ReleaseInputSummary, costUsd: number): Promise<ReleaseDraft> {
    const draft = this.#mustDraft(['generating']);
    return (await this.#setDraft({
      ...draft,
      status: 'ready',
      plan,
      input,
      notesText: formatNotes(plan.notes),
      checked: [],
      costUsd,
      updatedAt: this.#now().toISOString(),
    }))!;
  }

  async failRun(error: { code?: string; message: string }): Promise<ReleaseDraft> {
    const draft = this.#mustDraft(['generating']);
    return (await this.#setDraft({
      ...draft,
      status: 'failed',
      error: { code: error.code ?? 'agent_failed', message: error.message },
      updatedAt: this.#now().toISOString(),
    }))!;
  }

  // Saves the user's edits to a ready draft. `checked` replaces the ticked set.
  async update(raw: unknown): Promise<ReleaseDraft> {
    const draft = this.#mustDraft(['ready']);
    const changes = raw as { notes?: unknown; checked?: unknown } | null | undefined;
    if (!changes || typeof changes !== 'object') return fail('Edits must be an object', 'invalid_argument');
    const next = { ...draft };
    if (changes.notes !== undefined) {
      if (typeof changes.notes !== 'string') fail('notes must be text', 'invalid_argument', 'notes');
      const notes = changes.notes as string;
      if ([...notes].length > MAX_NOTES_TEXT) fail(`notes is longer than ${MAX_NOTES_TEXT} characters`, 'too_long', 'notes');
      if (CONTROL_CHARS.test(notes)) fail('notes contains control characters', 'invalid_text', 'notes');
      next.notesText = notes;
    }
    if (changes.checked !== undefined) {
      const count = draft.plan?.checklist.length ?? 0;
      const checked = changes.checked;
      if (!Array.isArray(checked) || checked.some((index) => !Number.isInteger(index) || index < 0 || index >= count)) {
        fail('checked must list checklist indices', 'invalid_argument', 'checked');
      }
      next.checked = [...new Set(checked as number[])].sort((a, b) => a - b);
    }
    next.updatedAt = this.#now().toISOString();
    return (await this.#setDraft(next))!;
  }

  // Records the ready draft as a release once every checklist item is ticked.
  async finish({ packageIds }: { packageIds: string[] }): Promise<Release> {
    const draft = this.#mustDraft(['ready']);
    const plan = draft.plan;
    if (!plan) return fail('The draft has no plan', 'invalid_state');
    const ticked = new Set(draft.checked);
    if (plan.checklist.some((_item, index) => !ticked.has(index))) fail('Tick every checklist item first', 'release_unchecked');
    if (!draft.notesText.trim()) fail('The release notes are empty', 'invalid_argument', 'notes');
    const release: Release = {
      id: this.#newId(),
      version: plan.nextVersion,
      startCommit: draft.startCommit,
      endCommit: draft.endCommit,
      notesText: draft.notesText,
      checklist: plan.checklist.map((item) => ({ ...item, checked: true })),
      packageIds,
      finishedAt: this.#now().toISOString(),
    };
    this.#state.history = [release, ...this.#state.history].slice(0, MAX_HISTORY);
    this.#state.releasedPackageIds = [...new Set([...this.#state.releasedPackageIds, ...packageIds])];
    await this.#setDraft(null);
    return structuredClone(release);
  }
}
