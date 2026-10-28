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
import path from 'node:path';
import crypto from 'node:crypto';

import { logger } from '../infrastructure/logger.ts';
import type { TaskCatalog, TaskDefinition } from '../work_packages/tasks.ts';
import type { Plan } from '../agents/product_lead.ts';
import type { InterfaceSummary, SkippedFile } from '../agents/architect.ts';
import type { ErrorInfo } from '../../shared/ipc/envelope.ts';
import type { ErrorCode } from '../../shared/error_codes.ts';
import type * as coursePlan from '../../shared/course_plan.ts';
import type { LabGeneration } from '../../shared/ipc/requirements.ts';
import { CONTROL_CHARS } from '../../shared/text_rules.ts';
import type { StateChanged } from '../infrastructure/state_changes.ts';
import { readStoredJson, writeStoredJson } from '../infrastructure/persisted_json.ts';
import type { Concept } from '../../shared/course_pack.ts';
import type { CoursePack } from '../../shared/course_pack.ts';
import { JsonWriteQueue } from '../infrastructure/atomic_json_file.ts';

export const REQUIREMENTS_FILENAME = 'requirements.json';
export const STATUSES = ['draft', 'clarifying', 'answering', 'planning', 'reviewing', 'published', 'failed'] as const;
const MAX_TITLE = 60;
export const MAX_TEXT = 4000;
export const MAX_ANSWER = 1000;

export type RequirementStatus = (typeof STATUSES)[number];

// The agent steps a requirement runs through.
export type RequirementStep = 'clarifying' | 'planning';

// Which agent is working during a run.
export type RequirementPhase = 'architect' | 'product-lead' | 'tutor';

// What the requirement asks for: work on the repository (project), or a
// path through a course pack (course). Absent on requirements from before
// course mode, which are all projects.
type RequirementKind = 'project' | 'course';

// [人工决策-2026-10-27 00:55:52] 课程模式复用需求的状态机：clarifying 是 Tutor 的目标访谈，planning 是规划学习路径
// 或起草课程包，reviewing 是学生调整路径或预览、编辑、确认草稿，published 是确认了路径（工作包由后续的 lab 生成器发布）。
// The pack the path is planned from: one the interview offered, or a new
// draft.
export type CourseChoice = { course: string } | { draft: true };

// A drafted pack, validated, waiting for the learner to edit and confirm it.
export type CourseDraft = { pack: CoursePack; contentHash: string };

// A course requirement's interview: the form, the pack Tutor picked (null
// when none fits) and the learner's choice, then the path or the draft.
export interface CourseInterview {
  form: coursePlan.GoalForm;
  // The packs offered (trusted, with a skeleton) and Tutor's pick among them.
  pick: { course: string | null; reason: string; options: { id: string; title: string }[] } | null;
  choice: CourseChoice | null;
  plan: coursePlan.CoursePlan | null;
  // The skeleton's concepts on the path, as planned: their labels for the
  // page and their prerequisites for checking a reordered path.
  pathConcepts: Concept[];
  draft: CourseDraft | null;
  // The first lab's generation once the path is confirmed (../lab_generation_service.ts);
  // only what the learner may see, the lab itself stays private.
  lab?: LabGeneration | null;
  // The lab repository the path's labs are written into, once created; the
  // requirement is copied there and this one points at it.
  repositoryId?: string | null;
}

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
  error: ErrorInfo | null;
}

// A requirement and the work packages Product Lead generated from it.
export interface Requirement {
  id: string;
  kind?: RequirementKind;
  status: RequirementStatus;
  title: string;
  text: string;
  summary: string | null;
  questions: RequirementQuestion[];
  plan: Plan | null;
  packages: TaskDefinition[];
  interfaces: RequirementInterfaces | null;
  phase: RequirementPhase | null;
  error: ErrorInfo | null;
  failedStep: RequirementStep | null;
  costUsd: number;
  createdAt: string;
  updatedAt: string;
  // Course requirements only.
  course?: CourseInterview;
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
  #onChanged?: StateChanged;
  // Published packages, oldest requirement first; rebuilt whenever a
  // requirement is loaded, published or removed.
  #published: readonly TaskDefinition[] = [];
  #publishedById = new Map<string, TaskDefinition>();
  #newId: () => string;
  #now: () => Date;

  setOnChanged(listener: StateChanged): void {
    this.#onChanged = listener;
  }

  #notify() {
    try {
      this.#onChanged?.('requirements');
    } catch (error) {
      logger.error('[requirements] change listener failed', error);
    }
  }
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
      const saved = await readStoredJson(this.#file, 1);
      const items = Array.isArray(saved) ? saved : (saved as { items?: unknown } | null)?.items;
      for (const item of (Array.isArray(items) ? items : []) as Requirement[]) {
        if (typeof item?.id !== 'string' || !isStatus(item.status)) continue;
        if (item.status === 'clarifying' || item.status === 'planning') {
          item.failedStep = item.status;
          item.phase = null;
          item.status = 'failed';
          item.error = { code: 'agent_interrupted', message: `TaskPilot 在 ${item.kind === 'course' ? 'Tutor' : 'Product Lead'} 运行时退出了` };
        }
        if (item.course?.lab?.status === 'running')
          item.course.lab = {
            ...item.course.lab,
            status: 'failed',
            phase: null,
            error: { code: 'agent_interrupted', message: 'TaskPilot 在生成 lab 时退出了' },
          };
        this.#items.set(item.id, item);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'unsupported_version') throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    this.#rebuildCatalog();
    return this;
  }

  #writes = new JsonWriteQueue();

  #persist = async () => {
    await this.#writes.enqueue(() => writeStoredJson(this.#file, { version: 1, items: [...this.#items.values()] }));
    this.#notify();
  };

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

  has(id: string): boolean {
    return this.#items.has(id);
  }

  // `course` makes a course requirement; its form is checked by the caller.
  async create({ title, text, course }: { title?: unknown; text?: unknown; course?: coursePlan.GoalForm }): Promise<Requirement> {
    const now = this.#now().toISOString();
    const item: Requirement = {
      id: this.#newId(),
      ...(course ? { kind: 'course' as const } : {}),
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
      ...(course ? { course: { form: course, pick: null, choice: null, plan: null, pathConcepts: [], draft: null } } : {}),
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

  // ========== Course interview ==========
  #course(id: string, statuses: RequirementStatus[]): { item: Requirement; course: CourseInterview } {
    const item = this.#mustGet(id);
    if (item.kind !== 'course' || !item.course) return fail('Not a course requirement', 'invalid_state');
    this.#expect(item, statuses);
    return { item, course: item.course };
  }

  // Tutor's interview: a fresh pick clears the choice, path and draft.
  async finishCourseClarify(
    id: string,
    { title, summary, questions, pick }: { title: string; summary: string; questions: string[]; pick: NonNullable<CourseInterview['pick']> },
    costUsd: number | null = 0,
  ): Promise<Requirement> {
    const { item, course } = this.#course(id, ['clarifying']);
    return this.#update(id, {
      status: 'answering',
      phase: null,
      title: item.title || title,
      summary,
      questions: questions.map((text) => ({ text, answer: '' })),
      course: { ...course, pick, choice: null, plan: null, pathConcepts: [], draft: null },
      costUsd: item.costUsd + (costUsd ?? 0),
    });
  }

  // The pack the path is planned from; the next planning run reads it.
  async setCourseChoice(id: string, choice: CourseChoice): Promise<Requirement> {
    const { course } = this.#course(id, ['answering', 'reviewing', 'failed']);
    return this.#update(id, { course: { ...course, choice } });
  }

  async finishCoursePlan(id: string, plan: coursePlan.CoursePlan, pathConcepts: Concept[], costUsd: number | null = 0): Promise<Requirement> {
    const { item, course } = this.#course(id, ['planning']);
    return this.#update(id, {
      status: 'reviewing',
      phase: null,
      course: { ...course, plan, pathConcepts, draft: null },
      costUsd: item.costUsd + (costUsd ?? 0),
    });
  }

  async finishCourseDraft(id: string, draft: CourseDraft, costUsd: number | null = 0): Promise<Requirement> {
    const { item, course } = this.#course(id, ['planning']);
    return this.#update(id, {
      status: 'reviewing',
      phase: null,
      course: { ...course, plan: null, pathConcepts: [], draft },
      costUsd: item.costUsd + (costUsd ?? 0),
    });
  }

  // The learner saved the draft as a pack: it is offered and chosen, and the
  // next planning run plans the path with it.
  async useCourseDraft(id: string, option: { id: string; title: string }): Promise<Requirement> {
    const { course } = this.#course(id, ['reviewing']);
    if (!course.draft || !course.pick) return fail('There is no drafted course pack', 'invalid_state');
    const options = [...course.pick.options.filter((entry) => entry.id !== option.id), option];
    return this.#update(id, { course: { ...course, pick: { ...course.pick, options }, choice: { course: option.id }, draft: null } });
  }

  // The learner's path after they reordered or marked it; checked by the caller.
  async setCoursePath(id: string, path: coursePlan.PathEntry[]): Promise<Requirement> {
    const { course } = this.#course(id, ['reviewing']);
    if (!course.plan) return fail('There is no path to change', 'invalid_state');
    const knownConcepts = path.filter((entry) => entry.status === 'known').map((entry) => entry.conceptId);
    return this.#update(id, { course: { ...course, plan: { ...course.plan, path, goal: { ...course.plan.goal, knownConcepts } } } });
  }

  // The learner marked a planned concept skipped after the path was
  // confirmed, when its labs kept failing at the easiest level.
  async skipCourseConcept(id: string, conceptId: string): Promise<Requirement> {
    const { course } = this.#course(id, ['published']);
    if (!course.plan?.path.some((entry) => entry.conceptId === conceptId && entry.status === 'planned'))
      return fail(`${conceptId} is not a concept still to learn on the path`, 'invalid_argument', 'conceptId');
    const path = course.plan.path.map((entry) => (entry.conceptId === conceptId ? { ...entry, status: 'skipped' as const } : entry));
    return this.#update(id, { course: { ...course, plan: { ...course.plan, path } } });
  }

  // The learner confirmed the path. Its labs are published later, so the
  // requirement adds nothing to the queue.
  async confirmCoursePath(id: string): Promise<Requirement> {
    const { course } = this.#course(id, ['reviewing']);
    if (!course.plan) return fail('There is no path to confirm', 'invalid_state');
    return this.#update(id, { status: 'published' });
  }

  // The first lab's generation state; `costUsd` is what this update adds.
  async setCourseLab(id: string, lab: LabGeneration, costUsd = 0): Promise<Requirement> {
    const { item, course } = this.#course(id, ['published']);
    if (!course.plan) return fail('There is no confirmed path', 'invalid_state');
    return this.#update(id, { course: { ...course, lab }, costUsd: item.costUsd + costUsd });
  }

  // A confirmed course path as given: the copy the lab repository keeps
  // once created for it, or the one left where the interview ran, which
  // then only points at the lab repository (`course.repositoryId`).
  async putCourse(item: Requirement): Promise<Requirement> {
    if (item.kind !== 'course' || item.status !== 'published' || !item.course?.plan) return fail('Not a confirmed course path', 'invalid_state');
    this.#items.set(item.id, structuredClone({ ...item, packages: [], updatedAt: this.#now().toISOString() }));
    this.#rebuildCatalog();
    await this.#persist();
    return this.get(item.id);
  }

  async finishPlan(id: string, plan: Plan, costUsd: number | null = 0): Promise<Requirement> {
    const item = this.#mustGet(id);
    this.#expect(item, ['planning']);
    return this.#update(id, { status: 'reviewing', phase: null, plan, costUsd: item.costUsd + (costUsd ?? 0) });
  }

  async failRun(id: string, step: RequirementStep, error: { code?: ErrorCode; message: string }): Promise<Requirement> {
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
    const reviewed = item.status === 'reviewing';
    const course = item.course && reviewed ? { course: { ...item.course, plan: null, pathConcepts: [], draft: null } } : {};
    return this.#update(id, { questions, status: 'answering', plan: reviewed ? null : item.plan, ...course });
  }

  // Stores the published task definitions and closes the requirement.
  async publish(id: string, definitions: TaskDefinition[]): Promise<Requirement> {
    const item = this.#mustGet(id);
    this.#expect(item, ['reviewing']);
    const published = await this.#update(id, { status: 'published', packages: definitions });
    this.#rebuildCatalog();
    return published;
  }

  // Publishes packages Product Lead did not plan (a course lab repository's
  // labs, ../lab_service.ts) under requirement `id`, created on first use
  // with no plan; later calls append. An id already in the catalog is refused.
  async publishPackages(id: string, { title, text }: { title: string; text: string }, definitions: TaskDefinition[]): Promise<Requirement> {
    const known = this.#items.get(id);
    if (known) this.#expect(known, ['published']);
    if (definitions.some((definition) => this.#publishedById.has(definition.id))) fail('A package with this id is already published', 'invalid_state');
    const now = this.#now().toISOString();
    const item: Requirement = known
      ? { ...known, packages: [...known.packages, ...definitions], updatedAt: now }
      : {
          id,
          status: 'published',
          title: userText(title, 'title', MAX_TITLE),
          text: userText(text, 'text', MAX_TEXT),
          summary: null,
          questions: [],
          plan: null,
          packages: definitions,
          interfaces: null,
          phase: null,
          error: null,
          failedStep: null,
          costUsd: 0,
          createdAt: now,
          updatedAt: now,
        };
    this.#items.set(id, item);
    this.#rebuildCatalog();
    await this.#persist();
    return structuredClone(item);
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
