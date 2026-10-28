// Runtime state for work packages: status, baseline commit, step progress and
// deviation reports. Kept apart from ./tasks.js, which holds the definitions
// authored by the AI team — definitions are replaced wholesale when a package
// is re-planned, while this state belongs to the human's execution of it.
//
// Persisted to disk so closing the app does not lose half-finished work.
import fs from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../infrastructure/logger.ts';
import * as status from './work_package_status.ts';
import { readStoredJson, writeStoredJson } from '../infrastructure/persisted_json.ts';
import type { Actor, TransitionName } from './work_package_status.ts';
import type { CodingRun } from '../../shared/coding_types.ts';
import type { ErrorCode } from '../../shared/error_codes.ts';
import type { StateChanged } from '../infrastructure/state_changes.ts';
import * as packageState from './work_package_state.ts';
type WorkPackageState = packageState.WorkPackageState;
type StoreTask = packageState.StoreTask;
type Deviation = packageState.Deviation;
type DeviationInput = packageState.DeviationInput;
type DeviationResolution = packageState.DeviationResolution;
type BaselineChecks = packageState.BaselineChecks;
type Review = packageState.Review;
type ReviewResult = packageState.ReviewResult;
type AdjudicationOutcome = packageState.AdjudicationOutcome;
type StoreSummary = packageState.StoreSummary;
const {
  ADJUDICATION_TRANSITIONS,
  BASELINE_STATUSES,
  allowed,
  initialState,
  lastDeviation,
  recoverCodingRun,
  recoverInterruptedAgents,
  revertReplan,
  StoreError,
} = packageState;
import type { TaskDefinition } from './tasks.ts';
import type { ExecutionMode, Grade, ReferenceRun } from '../../shared/ipc/packages.ts';
import type { HintUse } from '../../shared/hint_ladder.ts';
import { JsonWriteQueue } from '../infrastructure/atomic_json_file.ts';
import type { TaskRevisionDefinition } from './tasks.ts';
export const STATE_FILENAME = 'work-packages.json';

export class WorkPackageStore {
  #file: string;
  #state = new Map<string, WorkPackageState>();
  #tasks: StoreTask[] = [];
  #onChanged?: StateChanged;

  setOnChanged(listener: StateChanged): void {
    this.#onChanged = listener;
  }

  #notify() {
    try {
      this.#onChanged?.('packages');
    } catch (error) {
      logger.error('[packages] change listener failed', error);
    }
  }
  constructor(configDir: string) {
    this.#file = path.join(configDir, STATE_FILENAME);
  }

  // Rebinds the store to another data directory (a repository switch) and
  // loads it. Pending writes land in the old directory first.
  async open(configDir: string, tasks: readonly StoreTask[]): Promise<this> {
    await this.flush();
    this.#file = path.join(configDir, STATE_FILENAME);
    this.#state = new Map();
    return this.load(tasks);
  }

  // Seeds from task definitions, then overlays anything already on disk.
  async load(tasks: readonly StoreTask[]): Promise<this> {
    this.#tasks = [...tasks];
    for (const task of tasks) this.#state.set(task.id, initialState(task));
    try {
      const saved = await readStoredJson(this.#file, 1);
      const state = saved && typeof saved === 'object' && !Array.isArray(saved) && 'version' in saved && 'state' in saved ? saved.state : saved;
      if (!state || typeof state !== 'object' || Array.isArray(state)) return this;
      for (const [id, entry] of Object.entries(state)) {
        if (!this.#state.has(id) || !status.isStatus(entry?.status)) continue;
        const merged = { ...this.#state.get(id), ...entry } as WorkPackageState;
        recoverInterruptedAgents(merged);
        recoverCodingRun(merged);
        this.#state.set(id, merged);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'unsupported_version') throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    return this;
  }

  // Adds newly published packages. Existing ids keep their state, so
  // re-publishing never discards progress.
  add(tasks: StoreTask[]) {
    let added = false;
    for (const task of tasks) {
      if (this.#state.has(task.id)) continue;
      this.#tasks.push(task);
      this.#state.set(task.id, initialState(task));
      added = true;
    }
    if (added) this.#notify();
  }

  #writes = new JsonWriteQueue();

  #persist = async () => {
    await this.#writes.enqueue(() => writeStoredJson(this.#file, { version: 1, state: Object.fromEntries(this.#state) }));
    this.#notify();
  };

  // Resolves once every write so far has landed.
  flush(): Promise<void> {
    return this.#writes.flush();
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
    { baseline, deviation, mode }: { baseline?: string | null; deviation?: DeviationInput | null; mode?: ExecutionMode | null } = {},
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
      entry.mode = mode ?? null;
      // Claiming accepts the replanned package; the old plan is gone.
      entry.replanUndo = null;
    }
    if (name === 'release') {
      entry.baseline = null;
      entry.claimedAt = null;
      entry.completedSteps = [];
      entry.review = null;
      entry.baselineChecks = null;
      entry.mode = null;
      entry.referenceRun = null;
      entry.grade = null;
      entry.hints = [];
      entry.snippetCopies = 0;
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
    if (name === 'revert_replan') revertReplan(entry);
    if (name === 'accepted' || name === 'acceptance_rejected') {
      // The human's call on QA's pass; the review itself stays as QA wrote it.
      entry.review = { ...(entry.review as Review), humanVerdict: name, humanAt: new Date().toISOString() };
    }

    if (next === 'done') entry.completedAt = new Date().toISOString();
    entry.status = next;
    this.#state.set(id, entry);
    await this.#persist();
    return structuredClone(entry);
  }

  // Discards all execution state — status, baselines, step progress and
  // deviations — returning every package to its definition's seed state.
  async reset(): Promise<Record<string, WorkPackageState>> {
    try {
      await readStoredJson(this.#file, 1);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    this.#state = new Map(this.#tasks.map((task) => [task.id, initialState(task)]));
    await fs.rm(this.#file, { force: true });
    this.#notify();
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
    if (next === 'done') entry.completedAt = new Date().toISOString();
    entry.status = next;
    this.#state.set(id, entry);
    await this.#persist();
    return structuredClone(entry);
  }

  // Records a review that could not finish; the package stays in review.
  async failReview(id: string, error: { code?: ErrorCode; message: string }): Promise<WorkPackageState> {
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
        mode: entry.mode,
        hints: entry.hints,
        snippetCopies: entry.snippetCopies,
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
      entry.mode = null;
      entry.referenceRun = null;
      entry.grade = null;
      entry.hints = [];
      entry.snippetCopies = 0;
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
  async failAdjudication(id: string, error: { code?: ErrorCode; message: string }): Promise<WorkPackageState> {
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

  // Lets the developer start a package before `dependency` is done. Only
  // meaningful while the package has not been claimed yet.
  async waiveDependency(id: string, dependency: string): Promise<WorkPackageState> {
    const entry = this.get(id);
    if (entry.status !== 'pending') throw new StoreError('Dependencies only block a pending package', 'invalid_state');
    if (!entry.waivedDependencies.includes(dependency)) entry.waivedDependencies = [...entry.waivedDependencies, dependency];
    this.#state.set(id, entry);
    await this.#persist();
    return structuredClone(entry);
  }

  // Writes the practice records of one claim. `expect` is the id of the run
  // the caller started: a late write from a run that was replaced (release,
  // replan, a new claim) is dropped and null returned.
  async setReferenceRun(id: string, run: ReferenceRun | null, expect?: string): Promise<WorkPackageState | null> {
    const entry = this.get(id);
    if (expect !== undefined && entry.referenceRun?.id !== expect) return null;
    entry.referenceRun = run ? structuredClone(run) : null;
    this.#state.set(id, entry);
    await this.#persist();
    return structuredClone(entry);
  }

  async setGrade(id: string, grade: Grade | null, expect?: string): Promise<WorkPackageState | null> {
    const entry = this.get(id);
    if (expect !== undefined && entry.grade?.id !== expect) return null;
    entry.grade = grade ? structuredClone(grade) : null;
    this.#state.set(id, entry);
    await this.#persist();
    return structuredClone(entry);
  }

  // Records that a hint level was opened at a step; a level opened before
  // is not counted again.
  async recordHint(id: string, use: HintUse): Promise<WorkPackageState> {
    const entry = this.get(id);
    if (entry.hints.some((item) => item.stepIndex === use.stepIndex && item.level === use.level)) return structuredClone(entry);
    entry.hints = [...entry.hints, structuredClone(use)];
    this.#state.set(id, entry);
    await this.#persist();
    return structuredClone(entry);
  }

  async countSnippetCopy(id: string): Promise<WorkPackageState> {
    const entry = this.get(id);
    entry.snippetCopies += 1;
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
