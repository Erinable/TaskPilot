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
  };
}

class WorkPackageStore {
  #file;
  #state = new Map();

  constructor(configDir) {
    this.#file = path.join(configDir, STATE_FILENAME);
  }

  /** Seeds from task definitions, then overlays anything already on disk. */
  async load(tasks) {
    for (const task of tasks) this.#state.set(task.id, initialState(task));
    try {
      const saved = JSON.parse(await fs.readFile(this.#file, 'utf8'));
      for (const [id, entry] of Object.entries(saved)) {
        // Ignore ids that no longer exist and statuses we don't recognise:
        // the definitions are the authority on what a package is.
        if (!this.#state.has(id) || !status.isStatus(entry?.status)) continue;
        this.#state.set(id, { ...this.#state.get(id), ...entry });
      }
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      // A corrupt state file falls back to the seeded defaults rather than
      // blocking startup.
    }
    return this;
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
    }
    if (name === 'release') {
      entry.baseline = null;
      entry.claimedAt = null;
      entry.completedSteps = [];
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
