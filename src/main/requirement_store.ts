// Requirements and the work packages Product Lead generated from them.
//
// A requirement moves through:
//   draft → clarifying (agent running) → answering (questions shown)
//         → planning (agent running) → reviewing (plan shown)
//         → published (packages are in the work queue)
// and `failed` when an agent run fails, keeping the step it failed in so the
// user can retry that step.
//
// Published packages are stored here as task definitions; the store is also
// the work queue's TaskCatalog (see ./tasks.ts).
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

import type { TaskCatalog, TaskDefinition } from './tasks.ts';
import type { Plan } from './agents/product_lead.ts';
import type { InterfaceSummary, SkippedFile } from './agents/architect.ts';
import { CONTROL_CHARS } from '../shared/text_rules.ts';
import { JsonWriteQueue } from './atomic_json_file.ts';

export const REQUIREMENTS_FILENAME = 'requirements.json';
export const STATUSES = ['draft', 'clarifying', 'answering', 'planning', 'reviewing', 'published', 'failed'] as const;
const MAX_TITLE = 60;
export const MAX_TEXT = 4000;
export const MAX_ANSWER = 1000;

export type RequirementStatus = (typeof STATUSES)[number];

// The agent steps a requirement runs through.
export type RequirementStep = 'clarifying' | 'planning';

// Which agent is working during a run.
export type RequirementPhase = 'architect' | 'product-lead';

export interface RequirementQuestion {
  text: string;
  answer: string;
}

// Architect's interface summary for a requirement, or why there isn't one.
export interface RequirementInterfaces {
  summary: InterfaceSummary | null;
  text: string | null;
  read: { path: string; sha?: string }[];
  skipped: SkippedFile[];
  error: { code: string; message: string } | null;
}

// A requirement and the work packages Product Lead generated from it.
export interface Requirement {
  id: string;
  status: RequirementStatus;
  title: string;
  text: string;
  summary: string | null;
  questions: RequirementQuestion[];
  plan: Plan | null;
  packages: TaskDefinition[];
  interfaces: RequirementInterfaces | null;
  phase: RequirementPhase | null;
  error: { code: string; message: string } | null;
  failedStep: RequirementStep | null;
  costUsd: number;
  createdAt: string;
  updatedAt: string;
}

export type RequirementErrorCode = 'invalid_argument' | 'required' | 'too_long' | 'invalid_text' | 'unknown_requirement' | 'invalid_state';

export class RequirementError extends Error {
  code: RequirementErrorCode;
  field?: string;

  constructor(message: string, code: RequirementErrorCode, field?: string) {
    super(message);
    this.name = 'RequirementError';
    this.code = code;
    if (field) this.field = field;
  }
}

const fail = (message: string, code: RequirementErrorCode, field?: string): never => {
  throw new RequirementError(message, code, field);
};

const isStatus = (value: unknown): value is RequirementStatus => STATUSES.includes(value as RequirementStatus);

const userText = (value: unknown, field: string, max: number, { optional = false } = {}): string => {
  if ((value === undefined || value === null || value === '') && optional) return '';
  if (typeof value !== 'string') return fail(`${field} must be text`, 'invalid_argument', field);
  const trimmed = value.trim();
  if (!trimmed && !optional) fail(`${field} is required`, 'required', field);
  if ([...trimmed].length > max) fail(`${field} is longer than ${max} characters`, 'too_long', field);
  if (CONTROL_CHARS.test(trimmed)) fail(`${field} contains control characters`, 'invalid_text', field);
  return trimmed;
};

// Freezes a definition and everything in it, so the catalog can hand out the
// same objects on every read.
const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

export class RequirementStore implements TaskCatalog {
  #file: string;
  #items = new Map<string, Requirement>();
  // Published packages, oldest requirement first; rebuilt whenever a
  // requirement is loaded, published or removed.
  #published: readonly TaskDefinition[] = [];
  #publishedById = new Map<string, TaskDefinition>();
  #newId: () => string;
  #now: () => Date;

  constructor(
    configDir: string,
    { newId = () => `req-${crypto.randomBytes(4).toString('hex')}`, now = () => new Date() }: { newId?: () => string; now?: () => Date } = {},
  ) {
    this.#file = path.join(configDir, REQUIREMENTS_FILENAME);
    this.#newId = newId;
    this.#now = now;
  }

  // Rebinds the store to another data directory (a repository switch) and
  // loads it. Pending writes land in the old directory first.
  async open(configDir: string): Promise<this> {
    await this.flush();
    this.#file = path.join(configDir, REQUIREMENTS_FILENAME);
    this.#items = new Map();
    return this.load();
  }

  async load(): Promise<this> {
    try {
      const saved: unknown = JSON.parse(await fs.readFile(this.#file, 'utf8'));
      for (const item of (Array.isArray(saved) ? saved : []) as Requirement[]) {
        if (typeof item?.id !== 'string' || !isStatus(item.status)) continue;
        // A run that was in flight when the app quit can't be resumed.
        if (item.status === 'clarifying' || item.status === 'planning') {
          item.failedStep = item.status;
          item.phase = null;
          item.status = 'failed';
          item.error = { code: 'agent_interrupted', message: 'TaskPilot 在 Product Lead 运行时退出了' };
        }
        this.#items.set(item.id, item);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    this.#rebuildCatalog();
    return this;
  }

  #writes = new JsonWriteQueue();

  #persist = () => this.#writes.write(() => ({ file: this.#file, value: [...this.#items.values()] }));

  // Resolves once every write so far has landed.
  flush(): Promise<void> {
    return this.#writes.flush();
  }

  // Not named #require: electron-vite treats any "require" call text in the bundle as CommonJS and injects a shim at the wrong spot.
  #mustGet(id: string): Requirement {
    const item = this.#items.get(id);
    if (!item) return fail(`Unknown requirement: ${id}`, 'unknown_requirement');
    return item;
  }

  #expect(item: Requirement, statuses: RequirementStatus[]) {
    if (!statuses.includes(item.status)) fail(`Requirement is ${item.status}`, 'invalid_state');
  }

  async #update(id: string, changes: Partial<Requirement>): Promise<Requirement> {
    const item: Requirement = { ...this.#mustGet(id), ...changes, updatedAt: this.#now().toISOString() };
    this.#items.set(id, item);
    await this.#persist();
    return structuredClone(item);
  }

  list(): Requirement[] {
    return [...this.#items.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((item) => structuredClone(item));
  }

  get(id: string): Requirement {
    return structuredClone(this.#mustGet(id));
  }

  async create({ title, text }: { title?: unknown; text?: unknown }): Promise<Requirement> {
    const now = this.#now().toISOString();
    const item: Requirement = {
      id: this.#newId(),
      status: 'draft',
      title: userText(title, 'title', MAX_TITLE, { optional: true }),
      text: userText(text, 'text', MAX_TEXT),
      summary: null,
      questions: [],
      plan: null,
      packages: [],
      interfaces: null,
      phase: null,
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

  // Marks an agent step as running. Refuses if another run is in flight.
  async begin(id: string, step: RequirementStep): Promise<Requirement> {
    const item = this.#mustGet(id);
    const allowed: RequirementStatus[] = step === 'clarifying' ? ['draft', 'answering', 'failed'] : ['answering', 'reviewing', 'failed'];
    this.#expect(item, allowed);
    if (item.status === 'failed' && step === 'planning' && item.failedStep === 'clarifying') {
      fail('Clarification has not finished', 'invalid_state');
    }
    return this.#update(id, { status: step, error: null, failedStep: null });
  }

  // Which agent is working during a run, for the progress display.
  async setPhase(id: string, phase: RequirementPhase): Promise<Requirement> {
    const item = this.#mustGet(id);
    this.#expect(item, ['clarifying', 'planning']);
    return this.#update(id, { phase });
  }

  // Architect's interface summary, or why there isn't one.
  async setInterfaces(id: string, interfaces: RequirementInterfaces | null): Promise<Requirement> {
    this.#mustGet(id);
    return this.#update(id, { interfaces });
  }

  async finishClarify(
    id: string,
    { title, summary, questions }: { title: string; summary: string; questions: string[] },
    costUsd: number | null = 0,
  ): Promise<Requirement> {
    const item = this.#mustGet(id);
    this.#expect(item, ['clarifying']);
    return this.#update(id, {
      status: 'answering',
      phase: null,
      title: item.title || title,
      summary,
      questions: questions.map((text) => ({ text, answer: '' })),
      plan: null,
      costUsd: item.costUsd + (costUsd ?? 0),
    });
  }

  async finishPlan(id: string, plan: Plan, costUsd: number | null = 0): Promise<Requirement> {
    const item = this.#mustGet(id);
    this.#expect(item, ['planning']);
    return this.#update(id, { status: 'reviewing', phase: null, plan, costUsd: item.costUsd + (costUsd ?? 0) });
  }

  async failRun(id: string, step: RequirementStep, error: { code?: string; message: string }): Promise<Requirement> {
    this.#mustGet(id);
    return this.#update(id, {
      status: 'failed',
      phase: null,
      failedStep: step,
      error: { code: error.code ?? 'agent_failed', message: error.message },
    });
  }

  // Saves answers; only allowed while questions are shown.
  async setAnswers(id: string, answers: unknown): Promise<Requirement> {
    const item = this.#mustGet(id);
    this.#expect(item, ['answering', 'reviewing']);
    if (!Array.isArray(answers) || answers.length !== item.questions.length) {
      return fail('Answers must match the questions', 'invalid_argument', 'answers');
    }
    const questions = item.questions.map((q, i) => ({ ...q, answer: userText(answers[i] ?? '', `answers[${i}]`, MAX_ANSWER, { optional: true }) }));
    // Editing answers after a plan exists sends the user back to answering.
    return this.#update(id, { questions, status: 'answering', plan: item.status === 'reviewing' ? null : item.plan });
  }

  // Stores the published task definitions and closes the requirement.
  async publish(id: string, definitions: TaskDefinition[]): Promise<Requirement> {
    const item = this.#mustGet(id);
    this.#expect(item, ['reviewing']);
    const published = await this.#update(id, { status: 'published', packages: definitions });
    this.#rebuildCatalog();
    return published;
  }

  async remove(id: string): Promise<void> {
    const item = this.#mustGet(id);
    if (item.status === 'clarifying' || item.status === 'planning') fail('Wait for Product Lead to finish', 'invalid_state');
    this.#items.delete(id);
    this.#rebuildCatalog();
    await this.#persist();
  }

  #rebuildCatalog() {
    this.#published = deepFreeze(
      [...this.#items.values()]
        .filter((item) => item.status === 'published')
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .flatMap((item) => structuredClone(item.packages)),
    );
    this.#publishedById = new Map(this.#published.map((task) => [task.id, task]));
  }

  // Every published package, for the work queue.
  listTasks(): readonly TaskDefinition[] {
    return this.#published;
  }

  getTask(id: string): TaskDefinition | null {
    return this.#publishedById.get(id) ?? null;
  }
}
