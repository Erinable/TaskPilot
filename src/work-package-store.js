// Runtime state for work packages: status, baseline commit, step progress and
// deviation reports. Kept apart from ./tasks.js, which holds the definitions
// authored by the AI team — definitions are replaced wholesale when a package
// is re-planned, while this state belongs to the human's execution of it.
//
// Persisted to disk so closing the app does not lose half-finished work.
const fs = require('node:fs/promises');
const path = require('node:path');
const status = require('./work-package-status');

const STATE_FILENAME = 'work-packages.json';

class StoreError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

function initialState(task) {
  return {
    status: task.status,
    baseline: null, // git commit recorded when the human claims the package
    claimedAt: null,
    completedSteps: [], // indices into task.steps
    deviations: [],
    review: null, // QA's latest review of the package; see beginReview()
    // Submit-stage checks run on the claimed commit; see setBaselineChecks().
    // {status: measuring|measured|unavailable|contaminated, reason, commit, checks: {kind: record}, startedAt, finishedAt}
    baselineChecks: null,
  };
}

const BASELINE_STATUSES = ['measuring', 'measured', 'unavailable', 'contaminated'];

// The transition QA's outcome applies.
const REVIEW_TRANSITIONS = { passed: 'review_passed', rejected: 'review_rejected' };

class WorkPackageStore {
  #file;
  #state = new Map();
  #tasks = [];

  constructor(configDir) {
    this.#file = path.join(configDir, STATE_FILENAME);
  }

  /** Seeds from task definitions, then overlays anything already on disk. */
  async load(tasks) {
    this.#tasks = [...tasks];
    for (const task of tasks) this.#state.set(task.id, initialState(task));
    try {
      const saved = JSON.parse(await fs.readFile(this.#file, 'utf8'));
      for (const [id, entry] of Object.entries(saved)) {
        // Ignore ids that no longer exist and statuses we don't recognise:
        // the definitions are the authority on what a package is.
        if (!this.#state.has(id) || !status.isStatus(entry?.status)) continue;
        const merged = { ...this.#state.get(id), ...entry };
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
        this.#state.set(id, merged);
      }
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      // A corrupt state file falls back to the seeded defaults rather than
      // blocking startup.
    }
    return this;
  }

  /**
   * Adds newly published packages. Existing ids keep their state, so
   * re-publishing never discards progress.
   */
  add(tasks) {
    for (const task of tasks) {
      if (this.#state.has(task.id)) continue;
      this.#tasks.push(task);
      this.#state.set(task.id, initialState(task));
    }
  }

  async #persist() {
    await fs.mkdir(path.dirname(this.#file), { recursive: true });
    const plain = Object.fromEntries(this.#state);
    await fs.writeFile(this.#file, `${JSON.stringify(plain, null, 2)}\n`);
  }

  get(id) {
    const entry = this.#state.get(id);
    if (!entry) throw new StoreError(`Unknown work package: ${id}`, 'unknown_package');
    return structuredClone(entry);
  }

  all() {
    return Object.fromEntries([...this.#state].map(([id, entry]) => [id, structuredClone(entry)]));
  }

  /** Transitions a package, recording the baseline when it is claimed. */
  async transition(id, name, actor, { baseline, deviation } = {}) {
    const entry = this.get(id);
    const next = status.apply(entry.status, name, actor);

    if (name === 'claim') {
      if (!baseline) throw new StoreError('Claiming requires a baseline commit', 'baseline_required');
      entry.baseline = baseline;
      entry.claimedAt = new Date().toISOString();
      entry.baselineChecks = null;
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
        note: deviation.note.trim(),
        stepIndex: Number.isInteger(deviation.stepIndex) ? deviation.stepIndex : null,
        filePath: typeof deviation.filePath === 'string' ? deviation.filePath : null,
        reportedAt: new Date().toISOString(),
      });
    }

    entry.status = next;
    this.#state.set(id, entry);
    await this.#persist();
    return structuredClone(entry);
  }

  /**
   * Discards all execution state — status, baselines, step progress and
   * deviations — returning every package to its definition's seed state.
   */
  async reset() {
    this.#state = new Map(this.#tasks.map((task) => [task.id, initialState(task)]));
    await fs.rm(this.#file, { force: true });
    return this.all();
  }

  /**
   * Records baseline check results for the commit the package was claimed
   * at. A result for any other commit is dropped (the package was released
   * or re-claimed meanwhile) and null is returned.
   */
  async setBaselineChecks(id, value) {
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

  /** Counts for the data settings page. */
  summary() {
    const entries = [...this.#state.values()];
    return {
      total: entries.length,
      claimed: entries.filter((entry) => entry.baseline).length,
      deviations: entries.reduce((sum, entry) => sum + entry.deviations.length, 0),
    };
  }

  /**
   * Starts a QA review. Only a package in review can be reviewed, and only
   * one review runs at a time; a new one replaces the previous report.
   */
  async beginReview(id) {
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

  /**
   * Records QA's result and moves the package on: to acceptance when it
   * passed, back to the developer when it did not. The transition is applied
   * as the agent actor, so it goes through the same rules as everything else.
   * @param result pipeline.reviewWorkPackage() result
   */
  async completeReview(id, result) {
    const entry = this.get(id);
    if (entry.review?.status !== 'running') {
      throw new StoreError('No review is running', 'review_not_running');
    }
    const outcome = result.passed ? 'passed' : 'rejected';
    // Validate the transition before writing anything.
    const next = status.apply(entry.status, REVIEW_TRANSITIONS[outcome], 'agent');
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

  /** Records a review that could not finish; the package stays in review. */
  async failReview(id, error) {
    const entry = this.get(id);
    if (entry.review?.status !== 'running') return structuredClone(entry);
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

  /** Marks one instruction step done or not done. */
  async setStepDone(id, stepIndex, done) {
    const entry = this.get(id);
    if (!Number.isInteger(stepIndex) || stepIndex < 0) {
      throw new StoreError('stepIndex must be a non-negative integer', 'invalid_step');
    }
    const set = new Set(entry.completedSteps);
    done ? set.add(stepIndex) : set.delete(stepIndex);
    entry.completedSteps = [...set].sort((a, b) => a - b);
    this.#state.set(id, entry);
    await this.#persist();
    return structuredClone(entry);
  }
}

module.exports = { STATE_FILENAME, StoreError, WorkPackageStore };
