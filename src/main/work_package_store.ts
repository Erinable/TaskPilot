// Runtime state for work packages: status, baseline commit, step progress and
// deviation reports. Kept apart from ./tasks.js, which holds the definitions
// authored by the AI team — definitions are replaced wholesale when a package
// is re-planned, while this state belongs to the human's execution of it.
//
// Persisted to disk so closing the app does not lose half-finished work.
import fs from 'node:fs/promises';
import path from 'node:path';
import * as status from './work_package_status.ts';
import type { Actor, TransitionName, WorkPackageStatus } from './work_package_status.ts';
import type { TaskDefinition, TaskRevisionDefinition } from './tasks.ts';
import type { AttentionItem, BaselineCheck, CriterionResult, EvidenceItem } from './evidence.ts';
import type { CheckKind } from './workspace.ts';

import type { CodingRun } from '../shared/coding_types.ts';
export const STATE_FILENAME = 'work-packages.json';

// Why an agent run failed.
export interface AgentError {
  code: string;
  message: string;
}

export type ReviewStatus = 'running' | 'passed' | 'rejected' | 'failed';

// QA's latest review of a package. The result fields are present once it finished.
export interface Review {
  status: ReviewStatus;
  startedAt: string;
  finishedAt: string | null;
  error: AgentError | null;
  reasons?: string[];
  attention?: AttentionItem[];
  checks?: EvidenceItem[];
  verification?: unknown;
  acceptance?: CriterionResult[];
  report?: unknown;
  diff?: unknown;
  costUsd?: number;
  // The human's call on QA's pass.
  humanVerdict?: 'accepted' | 'acceptance_rejected';
  humanAt?: string;
}

// pipeline.reviewWorkPackage() result, as completeReview() reads it.
export interface ReviewResult {
  passed: boolean;
  reasons: string[];
  attention?: AttentionItem[];
  checks?: EvidenceItem[];
  verification?: unknown;
  acceptance?: CriterionResult[];
  report?: unknown;
  diff?: unknown;
  costUsd?: number;
}

export type BaselineChecksStatus = 'measuring' | 'measured' | 'unavailable' | 'contaminated';

// Submit-stage checks run on the claimed commit.
export interface BaselineChecks {
  status: BaselineChecksStatus;
  reason: string | null;
  commit: string;
  checks: Partial<Record<CheckKind, BaselineCheck>>;
  startedAt: string;
  finishedAt: string | null;
}

export type AdjudicationDecision = 'dismiss' | 'replan';

// Architect's ruling on a deviation.
export interface DeviationResolution {
  decision: AdjudicationDecision;
  reason: string;
  changes: string[];
  decidedAt: string;
  afterContest: boolean;
  contested: boolean;
  reverted: boolean;
}

// A deviation the developer reported.
export interface Deviation {
  note: string;
  stepIndex: number | null;
  filePath: string | null;
  reportedAt: string;
  resolution: DeviationResolution | null;
}

// What the developer sends when reporting a deviation (untrusted).
export interface DeviationInput {
  note?: string;
  stepIndex?: unknown;
  filePath?: unknown;
}

// Architect's replan of a definition, overlaid by effective().
export interface PlanRevision {
  version: number;
  definition: TaskRevisionDefinition;
  reason: string;
  changes: string[];
  revisedAt: string;
}

export type AdjudicationStatus = 'running' | 'done' | 'failed';

// Architect's latest run on a deviation.
export interface Adjudication {
  status: AdjudicationStatus;
  mustReplan: boolean;
  startedAt: string;
  finishedAt: string | null;
  error: AgentError | null;
  read?: string[];
  skipped?: unknown[];
  costUsd?: number;
}

// pipeline.adjudicateDeviation() result, as completeAdjudication() reads it.
export interface AdjudicationOutcome {
  decision: AdjudicationDecision;
  reason: string;
  changes: string[];
  revision: TaskRevisionDefinition | null;
  read?: string[];
  skipped?: unknown[];
  costUsd?: number;
}

// Execution state kept from before a replan so the human can revert it.
export interface ReplanUndo {
  revision: PlanRevision | null;
  baseline: string | null;
  claimedAt: string | null;
  completedSteps: number[];
  baselineChecks: BaselineChecks | null;
  review: Review | null;
}

// Runtime state of one work package.
export interface WorkPackageState {
  status: WorkPackageStatus;
  baseline: string | null;
  claimedAt: string | null;
  completedSteps: number[];
  deviations: Deviation[];
  review: Review | null;
  baselineChecks: BaselineChecks | null;
  revision: PlanRevision | null;
  adjudication: Adjudication | null;
  replanUndo: ReplanUndo | null;
  codingRun: CodingRun | null;
}

export interface StoreSummary {
  total: number;
  claimed: number;
  deviations: number;
}

export type StoreErrorCode =
  | 'unknown_package'
  | 'invalid_state'
  | 'baseline_required'
  | 'deviation_note_required'
  | 'invalid_argument'
  | 'review_running'
  | 'review_not_running'
  | 'adjudication_running'
  | 'adjudication_not_running'
  | 'invalid_step';

export class StoreError extends Error {
  code: StoreErrorCode;

  constructor(message: string, code: StoreErrorCode) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

const initialState = (task: Pick<TaskDefinition, 'status'>): WorkPackageState => ({
  status: task.status,
  baseline: null, // git commit recorded when the human claims the package
  claimedAt: null,
  completedSteps: [], // indices into task.steps
  deviations: [],
  review: null, // QA's latest review; see beginReview()
  baselineChecks: null,
  revision: null,
  adjudication: null, // Architect's latest run on a deviation
  replanUndo: null,
  codingRun: null,
});

const BASELINE_STATUSES: string[] = ['measuring', 'measured', 'unavailable', 'contaminated'];

// The transition Architect's ruling applies.
const ADJUDICATION_TRANSITIONS: Record<AdjudicationDecision, TransitionName> = { dismiss: 'deviation_dismissed', replan: 'replanned' };

const lastDeviation = (entry: WorkPackageState): Deviation | null => entry.deviations[entry.deviations.length - 1] ?? null;

// Human transitions that also depend on state beyond the status.
const GUARDS: Partial<Record<string, (entry: WorkPackageState) => boolean>> = {
  // Only an uncontested dismissal can be contested.
  override_dismissal: (entry) => {
    const resolution = lastDeviation(entry)?.resolution;
    return resolution?.decision === 'dismiss' && !resolution.contested;
  },
  revert_replan: (entry) => entry.replanUndo !== null,
};
const allowed = (entry: WorkPackageState, name: string) => GUARDS[name]?.(entry) ?? true;

// Human transitions available for an entry, after the state guards.
export const humanTransitions = (entry: WorkPackageState): TransitionName[] =>
  status
    .available(entry.status, 'human')
    .map((t) => t.name)
    .filter((name) => allowed(entry, name));

// The task fields the store needs: its id and seed status.
type StoreTask = Pick<TaskDefinition, 'id' | 'status'>;

export class WorkPackageStore {
  #file: string;
  #state = new Map<string, WorkPackageState>();
  #tasks: StoreTask[] = [];

  constructor(configDir: string) {
    this.#file = path.join(configDir, STATE_FILENAME);
  }

  // Rebinds the store to another data directory (a repository switch) and
  // loads it. Pending writes land in the old directory first.
  async open(configDir: string, tasks: StoreTask[]): Promise<this> {
    await this.flush();
    this.#file = path.join(configDir, STATE_FILENAME);
    this.#state = new Map();
    return this.load(tasks);
  }

  // Seeds from task definitions, then overlays anything already on disk.
  async load(tasks: StoreTask[]): Promise<this> {
    this.#tasks = [...tasks];
    for (const task of tasks) this.#state.set(task.id, initialState(task));
    try {
      const saved: Record<string, Partial<WorkPackageState> | null> = JSON.parse(await fs.readFile(this.#file, 'utf8'));
      for (const [id, entry] of Object.entries(saved)) {
        // Ignore ids that no longer exist and statuses we don't recognise:
        // the definitions are the authority on what a package is.
        if (!this.#state.has(id) || !status.isStatus(entry?.status)) continue;
        const merged = { ...this.#state.get(id), ...entry } as WorkPackageState;
        // A review still running when the app closed will never finish.
        if (merged.review?.status === 'running') {
          merged.review = {
            ...merged.review,
            status: 'failed',
            finishedAt: null,
            error: { code: 'agent_interrupted', message: 'The review was interrupted when the app closed' },
          };
        }
        // Nor will a baseline measurement.
        if (merged.baselineChecks?.status === 'measuring') {
          merged.baselineChecks = { ...merged.baselineChecks, status: 'unavailable', reason: 'interrupted', finishedAt: null };
        }
        // Nor an adjudication; the package stays in deviation for a retry.
        if (merged.adjudication?.status === 'running') {
          merged.adjudication = {
            ...merged.adjudication,
            status: 'failed',
            finishedAt: null,
            error: { code: 'agent_interrupted', message: 'The adjudication was interrupted when the app closed' },
          };
        }
        // Runs saved before per-role runtimes always used the Codex default.
        if (merged.codingRun && !merged.codingRun.cli) {
          merged.codingRun = { ...merged.codingRun, cli: 'codex', model: '', thinking: 'default' };
        }
        // Runs saved before the automatic loop were a single developer round.
        if (merged.codingRun && merged.codingRun.attempt === undefined) {
          merged.codingRun = { ...merged.codingRun, attempt: 1, trigger: 'human', feedback: null, halt: null, rounds: [] };
        }
        // The patch is already in the working tree; only the checks were cut short.
        if (merged.codingRun?.status === 'verifying') {
          merged.codingRun = {
            ...merged.codingRun,
            status: 'applied',
            halt: 'stopped',
            error: { code: 'coding_interrupted', message: 'Checks were interrupted when the app closed' },
          };
        }
        if (merged.codingRun && ['preparing', 'running', 'checking', 'applying'].includes(merged.codingRun.status)) {
          merged.codingRun = {
            ...merged.codingRun,
            status: 'failed',
            finishedAt: null,
            error: { code: 'coding_interrupted', message: 'Coding Agent was interrupted when the app closed' },
          };
        }
        this.#state.set(id, merged);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      // A corrupt state file falls back to the seeded defaults rather than
      // blocking startup.
    }
    return this;
  }

  // Adds newly published packages. Existing ids keep their state, so
  // re-publishing never discards progress.
  add(tasks: StoreTask[]) {
    for (const task of tasks) {
      if (this.#state.has(task.id)) continue;
      this.#tasks.push(task);
      this.#state.set(task.id, initialState(task));
    }
  }

  // Writes are chained and go through a temp file, so they never overlap and
  // a crash mid-write leaves the previous file intact (see requirement_store.ts).
  #writes: Promise<void> = Promise.resolve();

  #persist(): Promise<void> {
    const write = this.#writes.then(async () => {
      await fs.mkdir(path.dirname(this.#file), { recursive: true });
      const tmp = `${this.#file}.tmp`;
      // Snapshot at write time, so the file always reflects the latest state.
      await fs.writeFile(tmp, `${JSON.stringify(Object.fromEntries(this.#state), null, 2)}\n`);
      await fs.rename(tmp, this.#file);
    });
    this.#writes = write.catch(() => {});
    return write;
  }

  // Resolves once every write so far has landed.
  flush(): Promise<void> {
    return this.#writes;
  }

  get(id: string): WorkPackageState {
    const entry = this.#state.get(id);
    if (!entry) throw new StoreError(`Unknown work package: ${id}`, 'unknown_package');
    return structuredClone(entry);
  }

  all(): Record<string, WorkPackageState> {
    return Object.fromEntries([...this.#state].map(([id, entry]) => [id, structuredClone(entry)]));
  }

  // The definition with Architect's latest replan, if any, laid over it.
  effective<T extends Pick<TaskDefinition, 'id'>>(task: T): T {
    const revision = this.#state.get(task.id)?.revision;
    return revision ? { ...task, ...structuredClone(revision.definition) } : task;
  }

  // Transitions a package, recording the baseline when it is claimed.
  async transition(
    id: string,
    name: TransitionName,
    actor?: Actor | null,
    { baseline, deviation }: { baseline?: string | null; deviation?: DeviationInput | null } = {},
  ): Promise<WorkPackageState> {
    const entry = this.get(id);
    const next = status.apply(entry.status, name, actor);
    if (!allowed(entry, name)) {
      throw new StoreError(`Transition "${name}" is not available now`, 'invalid_state');
    }

    if (name === 'claim') {
      if (!baseline) throw new StoreError('Claiming requires a baseline commit', 'baseline_required');
      entry.baseline = baseline;
      entry.claimedAt = new Date().toISOString();
      entry.baselineChecks = null;
      // Claiming accepts the replanned package; the old plan is gone.
      entry.replanUndo = null;
    }
    if (name === 'release') {
      entry.baseline = null;
      entry.claimedAt = null;
      entry.completedSteps = [];
      entry.review = null;
      entry.baselineChecks = null;
    }
    if (name === 'report_deviation') {
      if (!deviation?.note?.trim()) {
        throw new StoreError('A deviation needs a note', 'deviation_note_required');
      }
      entry.deviations.push({
        note: (deviation.note as string).trim(),
        stepIndex: Number.isInteger(deviation.stepIndex) ? (deviation.stepIndex as number) : null,
        filePath: typeof deviation.filePath === 'string' ? deviation.filePath : null,
        reportedAt: new Date().toISOString(),
        resolution: null, // set by completeAdjudication()
      });
      entry.adjudication = null;
    }
    if (name === 'override_dismissal') {
      // The same deviation goes back to Architect, which must now replan.
      // The guard checked there is an uncontested dismissal.
      (lastDeviation(entry) as Deviation & { resolution: DeviationResolution }).resolution.contested = true;
      entry.adjudication = null;
    }
    if (name === 'revert_replan') {
      // The guard checked there is something to revert.
      const undo = entry.replanUndo as ReplanUndo;
      (lastDeviation(entry) as Deviation & { resolution: DeviationResolution }).resolution.reverted = true;
      entry.revision = undo.revision;
      entry.baseline = undo.baseline;
      entry.claimedAt = undo.claimedAt;
      entry.completedSteps = undo.completedSteps;
      entry.baselineChecks = undo.baselineChecks;
      entry.review = undo.review;
      entry.replanUndo = null;
    }
    if (name === 'accepted' || name === 'acceptance_rejected') {
      // The human's call on QA's pass; the review itself stays as QA wrote it.
      entry.review = { ...(entry.review as Review), humanVerdict: name, humanAt: new Date().toISOString() };
    }

    entry.status = next;
    this.#state.set(id, entry);
    await this.#persist();
    return structuredClone(entry);
  }

  // Discards all execution state — status, baselines, step progress and
  // deviations — returning every package to its definition's seed state.
  async reset(): Promise<Record<string, WorkPackageState>> {
    this.#state = new Map(this.#tasks.map((task) => [task.id, initialState(task)]));
    await fs.rm(this.#file, { force: true });
    return this.all();
  }

  // Records baseline check results for the commit the package was claimed
  // at. A result for any other commit is dropped (the package was released
  // or re-claimed meanwhile) and null is returned.
  async setBaselineChecks(id: string, value: BaselineChecks): Promise<WorkPackageState | null> {
    const entry = this.get(id);
    if (!BASELINE_STATUSES.includes(value?.status)) {
      throw new StoreError(`Unknown baseline status: ${value?.status}`, 'invalid_argument');
    }
    if (!entry.baseline || entry.baseline !== value.commit) return null;
    entry.baselineChecks = structuredClone(value);
    this.#state.set(id, entry);
    await this.#persist();
    return structuredClone(entry);
  }

  // Counts for the data settings page.
  summary(): StoreSummary {
    const entries = [...this.#state.values()];
    return {
      total: entries.length,
      claimed: entries.filter((entry) => entry.baseline).length,
      deviations: entries.reduce((sum, entry) => sum + entry.deviations.length, 0),
    };
  }

  // Starts a QA review. Only a package in review can be reviewed, and only
  // one review runs at a time; a new one replaces the previous report.
  async beginReview(id: string): Promise<WorkPackageState> {
    const entry = this.get(id);
    if (entry.status !== 'in_review') {
      throw new StoreError('Only a package in review can be reviewed', 'invalid_state');
    }
    if (entry.review?.status === 'running') {
      throw new StoreError('A review is already running', 'review_running');
    }
    entry.review = { status: 'running', startedAt: new Date().toISOString(), finishedAt: null, error: null };
    this.#state.set(id, entry);
    await this.#persist();
    return structuredClone(entry);
  }

  // Records QA's result and moves the package on: straight to done when it
  // passed with nothing for the human to confirm, to acceptance when it
  // passed with attention items, back to the developer when it did not. The
  // transition is applied as the agent actor, so it goes through the same
  // rules as everything else.
  // result: pipeline.reviewWorkPackage() result
  async completeReview(id: string, result: ReviewResult): Promise<WorkPackageState> {
    const entry = this.get(id);
    if (!entry.review || entry.review.status !== 'running') {
      throw new StoreError('No review is running', 'review_not_running');
    }
    const outcome = result.passed ? 'passed' : 'rejected';
    // [人工决策-2026-10-05 21:57:41] 有「需要人工确认」项才停在待验收，否则 QA 通过即 done。
    const transition = !result.passed ? 'review_rejected' : (result.attention ?? []).length ? 'review_passed' : 'review_accepted';
    // Validate the transition before writing anything.
    const next = status.apply(entry.status, transition, 'agent');
    entry.review = {
      status: outcome,
      startedAt: entry.review.startedAt,
      finishedAt: new Date().toISOString(),
      error: null,
      reasons: result.reasons,
      attention: result.attention ?? [],
      checks: result.checks ?? [],
      verification: result.verification,
      acceptance: result.acceptance,
      report: result.report,
      diff: result.diff,
      costUsd: result.costUsd,
    };
    entry.status = next;
    this.#state.set(id, entry);
    await this.#persist();
    return structuredClone(entry);
  }

  // Records a review that could not finish; the package stays in review.
  async failReview(id: string, error: { code?: string; message: string }): Promise<WorkPackageState> {
    const entry = this.get(id);
    if (!entry.review || entry.review.status !== 'running') return structuredClone(entry);
    entry.review = {
      ...entry.review,
      status: 'failed',
      finishedAt: new Date().toISOString(),
      error: { code: error.code ?? 'agent_failed', message: error.message },
    };
    this.#state.set(id, entry);
    await this.#persist();
    return structuredClone(entry);
  }

  // Starts Architect's ruling on the latest deviation. `mustReplan` is set
  // when the developer contested an earlier dismissal of it.
  async beginAdjudication(id: string): Promise<WorkPackageState> {
    const entry = this.get(id);
    if (entry.status !== 'deviation') {
      throw new StoreError('Only a package with a deviation can be adjudicated', 'invalid_state');
    }
    if (entry.adjudication?.status === 'running') {
      throw new StoreError('An adjudication is already running', 'adjudication_running');
    }
    entry.adjudication = {
      status: 'running',
      mustReplan: lastDeviation(entry)?.resolution?.contested === true,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      error: null,
    };
    this.#state.set(id, entry);
    await this.#persist();
    return structuredClone(entry);
  }

  // Applies Architect's ruling. A dismissal returns the package to the
  // developer with execution state intact. A replan swaps in the revised
  // definition and returns the package to the queue, keeping the previous
  // execution state so the human can revert.
  // result: pipeline.adjudicateDeviation() result
  async completeAdjudication(id: string, result: AdjudicationOutcome): Promise<WorkPackageState> {
    const entry = this.get(id);
    if (!entry.adjudication || entry.adjudication.status !== 'running') {
      throw new StoreError('No adjudication is running', 'adjudication_not_running');
    }
    if (entry.adjudication.mustReplan && result.decision !== 'replan') {
      throw new StoreError('A contested dismissal must be replanned', 'invalid_state');
    }
    const next = status.apply(entry.status, ADJUDICATION_TRANSITIONS[result.decision], 'agent');
    const now = new Date().toISOString();
    // A package in deviation always has one reported.
    const deviation = lastDeviation(entry) as Deviation;
    deviation.resolution = {
      decision: result.decision,
      reason: result.reason,
      changes: result.changes,
      decidedAt: now,
      // A replan that answers a contested dismissal is recorded as such.
      afterContest: deviation.resolution?.contested === true,
      contested: false,
      reverted: false,
    };
    if (result.decision === 'replan') {
      entry.replanUndo = {
        revision: entry.revision,
        baseline: entry.baseline,
        claimedAt: entry.claimedAt,
        completedSteps: entry.completedSteps,
        baselineChecks: entry.baselineChecks,
        review: entry.review,
      };
      entry.revision = {
        version: (entry.revision?.version ?? 0) + 1,
        // validateAdjudication() requires a revision for a replan.
        definition: structuredClone(result.revision as TaskRevisionDefinition),
        reason: result.reason,
        changes: result.changes,
        revisedAt: now,
      };
      // Same as a release: the new plan is claimed from a fresh baseline.
      entry.baseline = null;
      entry.claimedAt = null;
      entry.completedSteps = [];
      entry.baselineChecks = null;
      entry.review = null;
    }
    entry.adjudication = {
      ...entry.adjudication,
      status: 'done',
      finishedAt: now,
      read: result.read ?? [],
      skipped: result.skipped ?? [],
      costUsd: result.costUsd,
    };
    entry.status = next;
    this.#state.set(id, entry);
    await this.#persist();
    return structuredClone(entry);
  }

  // Records an adjudication that could not finish; the package stays in deviation.
  async failAdjudication(id: string, error: { code?: string; message: string }): Promise<WorkPackageState> {
    const entry = this.get(id);
    if (!entry.adjudication || entry.adjudication.status !== 'running') return structuredClone(entry);
    entry.adjudication = {
      ...entry.adjudication,
      status: 'failed',
      finishedAt: new Date().toISOString(),
      error: { code: error.code ?? 'agent_failed', message: error.message },
    };
    this.#state.set(id, entry);
    await this.#persist();
    return structuredClone(entry);
  }

  async setCodingRun(id: string, run: CodingRun | null): Promise<WorkPackageState> {
    const entry = this.get(id);
    entry.codingRun = run ? structuredClone(run) : null;
    this.#state.set(id, entry);
    await this.#persist();
    return structuredClone(entry);
  }

  async updateCodingRun(id: string, patch: Partial<CodingRun>): Promise<WorkPackageState> {
    const entry = this.get(id);
    if (!entry.codingRun) throw new StoreError('No coding run exists', 'invalid_state');
    if (patch.id !== undefined || patch.packageId !== undefined || patch.baseline !== undefined || patch.runName !== undefined) {
      throw new StoreError('Coding run identity cannot change', 'invalid_argument');
    }
    entry.codingRun = { ...entry.codingRun, ...structuredClone(patch) };
    this.#state.set(id, entry);
    await this.#persist();
    return structuredClone(entry);
  }

  async setStepDone(id: string, stepIndex: number, done: boolean): Promise<WorkPackageState> {
    const entry = this.get(id);
    if (!Number.isInteger(stepIndex) || stepIndex < 0) {
      throw new StoreError('stepIndex must be a non-negative integer', 'invalid_step');
    }
    const set = new Set<number>(entry.completedSteps);
    if (done) set.add(stepIndex);
    else set.delete(stepIndex);
    entry.completedSteps = [...set].sort((a, b) => a - b);
    this.#state.set(id, entry);
    await this.#persist();
    return structuredClone(entry);
  }
}
