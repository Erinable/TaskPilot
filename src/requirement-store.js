// Requirements and the work packages Product Lead generated from them.
//
// A requirement moves through:
//   draft → clarifying (agent running) → answering (questions shown)
//         → planning (agent running) → reviewing (plan shown)
//         → published (packages are in the work queue)
// and `failed` when an agent run fails, keeping the step it failed in so the
// user can retry that step.
//
// Published packages are stored here as task definitions; ../tasks.js merges
// them with the hand-written samples.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const REQUIREMENTS_FILENAME = 'requirements.json';
const STATUSES = ['draft', 'clarifying', 'answering', 'planning', 'reviewing', 'published', 'failed'];
const MAX_TITLE = 60;
const MAX_TEXT = 4000;
const MAX_ANSWER = 1000;
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/;

class RequirementError extends Error {
  constructor(message, code, field) {
    super(message);
    this.name = 'RequirementError';
    this.code = code;
    if (field) this.field = field;
  }
}

const fail = (message, code, field) => {
  throw new RequirementError(message, code, field);
};

function userText(value, field, max, { optional = false } = {}) {
  if ((value === undefined || value === null || value === '') && optional) return '';
  if (typeof value !== 'string') fail(`${field} must be text`, 'invalid_argument', field);
  const trimmed = value.trim();
  if (!trimmed && !optional) fail(`${field} is required`, 'required', field);
  if ([...trimmed].length > max) fail(`${field} is longer than ${max} characters`, 'too_long', field);
  if (CONTROL_CHARS.test(trimmed)) fail(`${field} contains control characters`, 'invalid_text', field);
  return trimmed;
}

class RequirementStore {
  #file;
  #items = new Map();
  #newId;
  #now;

  constructor(configDir, { newId = () => `req-${crypto.randomBytes(4).toString('hex')}`, now = () => new Date() } = {}) {
    this.#file = path.join(configDir, REQUIREMENTS_FILENAME);
    this.#newId = newId;
    this.#now = now;
  }

  async load() {
    try {
      const saved = JSON.parse(await fs.readFile(this.#file, 'utf8'));
      for (const item of Array.isArray(saved) ? saved : []) {
        if (typeof item?.id !== 'string' || !STATUSES.includes(item.status)) continue;
        // A run that was in flight when the app quit can't be resumed.
        if (item.status === 'clarifying' || item.status === 'planning') {
          item.failedStep = item.status;
          item.status = 'failed';
          item.error = { code: 'agent_interrupted', message: 'TaskPilot 在 Product Lead 运行时退出了' };
        }
        this.#items.set(item.id, item);
      }
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    return this;
  }

  // Writes are chained so they never overlap. An agent run finishing in the
  // background can save at the same moment as a user edit; without the chain
  // both would share the temp file and one rename would fail.
  #writes = Promise.resolve();

  #persist() {
    const write = this.#writes.then(async () => {
      await fs.mkdir(path.dirname(this.#file), { recursive: true });
      const tmp = `${this.#file}.tmp`;
      // Snapshot at write time, so the file always reflects the latest state.
      await fs.writeFile(tmp, `${JSON.stringify([...this.#items.values()], null, 2)}\n`);
      await fs.rename(tmp, this.#file);
    });
    // Keep the chain alive after a failed write; the caller still sees the error.
    this.#writes = write.catch(() => {});
    return write;
  }

  #require(id) {
    const item = this.#items.get(id);
    if (!item) fail(`Unknown requirement: ${id}`, 'unknown_requirement');
    return item;
  }

  #expect(item, statuses) {
    if (!statuses.includes(item.status)) fail(`Requirement is ${item.status}`, 'invalid_state');
  }

  async #update(id, changes) {
    const item = { ...this.#require(id), ...changes, updatedAt: this.#now().toISOString() };
    this.#items.set(id, item);
    await this.#persist();
    return structuredClone(item);
  }

  list() {
    return [...this.#items.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((item) => structuredClone(item));
  }

  get(id) {
    return structuredClone(this.#require(id));
  }

  async create({ title, text }) {
    const now = this.#now().toISOString();
    const item = {
      id: this.#newId(),
      status: 'draft',
      title: userText(title, 'title', MAX_TITLE, { optional: true }),
      text: userText(text, 'text', MAX_TEXT),
      summary: null,
      questions: [],
      plan: null,
      packages: [],
      error: null,
      failedStep: null,
      costUsd: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.#items.set(item.id, item);
    await this.#persist();
    return structuredClone(item);
  }

  /** Marks an agent step as running. Refuses if another run is in flight. */
  async begin(id, step) {
    const item = this.#require(id);
    const allowed = step === 'clarifying'
      ? ['draft', 'answering', 'failed']
      : ['answering', 'reviewing', 'failed'];
    this.#expect(item, allowed);
    if (item.status === 'failed' && step === 'planning' && item.failedStep === 'clarifying') {
      fail('Clarification has not finished', 'invalid_state');
    }
    return this.#update(id, { status: step, error: null, failedStep: null });
  }

  async finishClarify(id, { title, summary, questions }, costUsd = 0) {
    const item = this.#require(id);
    this.#expect(item, ['clarifying']);
    return this.#update(id, {
      status: 'answering',
      title: item.title || title,
      summary,
      questions: questions.map((text) => ({ text, answer: '' })),
      plan: null,
      costUsd: item.costUsd + (costUsd ?? 0),
    });
  }

  async finishPlan(id, plan, costUsd = 0) {
    const item = this.#require(id);
    this.#expect(item, ['planning']);
    return this.#update(id, { status: 'reviewing', plan, costUsd: item.costUsd + (costUsd ?? 0) });
  }

  async failRun(id, step, error) {
    this.#require(id);
    return this.#update(id, {
      status: 'failed',
      failedStep: step,
      error: { code: error.code ?? 'agent_failed', message: error.message },
    });
  }

  /** Saves answers; only allowed while questions are shown. */
  async setAnswers(id, answers) {
    const item = this.#require(id);
    this.#expect(item, ['answering', 'reviewing']);
    if (!Array.isArray(answers) || answers.length !== item.questions.length) {
      fail('Answers must match the questions', 'invalid_argument', 'answers');
    }
    const questions = item.questions.map((q, i) => ({ ...q, answer: userText(answers[i] ?? '', `answers[${i}]`, MAX_ANSWER, { optional: true }) }));
    // Editing answers after a plan exists sends the user back to answering.
    return this.#update(id, { questions, status: 'answering', plan: item.status === 'reviewing' ? null : item.plan });
  }

  /** Stores the published task definitions and closes the requirement. */
  async publish(id, definitions) {
    const item = this.#require(id);
    this.#expect(item, ['reviewing']);
    return this.#update(id, { status: 'published', packages: definitions });
  }

  async remove(id) {
    const item = this.#require(id);
    if (item.status === 'clarifying' || item.status === 'planning') fail('Wait for Product Lead to finish', 'invalid_state');
    this.#items.delete(id);
    await this.#persist();
  }

  /** Every published package, for the work queue. */
  publishedPackages() {
    return [...this.#items.values()]
      .filter((item) => item.status === 'published')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .flatMap((item) => structuredClone(item.packages));
  }
}

module.exports = { REQUIREMENTS_FILENAME, STATUSES, MAX_TEXT, MAX_ANSWER, RequirementError, RequirementStore };
