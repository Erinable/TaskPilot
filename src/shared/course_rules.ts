// The rules a course pack follows, shared so the renderer's pack editor
// shows the errors the main process would give, on the same fields. The
// main process (../main/course_file.ts) is the check that counts: it runs
// these rules again on every file it reads and every pack it saves.
//
// Every error names its field, e.g. `rubric[1].dimension`, and its kind,
// which the editor words for the user.
import { semverOrNull } from './semver.ts';
import { CONTROL_CHARS } from './text_rules.ts';
import { isLabToolchain, LAB_TOOLCHAINS } from './lab_toolchains.ts';
import * as coursePack from './course_pack.ts';
import type { Concept, CoursePack, RubricExample, RubricItem } from './course_pack.ts';

export const COURSE_LIMITS = {
  field: 500,
  guideLine: 300,
  guideLines: 8,
  minRubric: 2,
  maxRubric: 6,
  examples: 2,
  languages: 8,
  concepts: 200,
  conceptLabel: 60,
  conceptSummary: 300,
  prerequisites: 8,
  // The pack's JSON, which is a little larger than its text in a prompt.
  // Concepts are measured on their own: a skeleton of a few dozen nodes is
  // larger than the rest of the pack, and no prompt renders all of it at once.
  packBytes: 8 * 1024,
  conceptsBytes: 48 * 1024,
} as const;

// The tags prompts wrap their data in.
const PROMPT_TAG = /<\/?[a-z_]+>/;

const TOP_KEYS = new Set([
  'schemaVersion',
  'id',
  'version',
  'domain',
  'title',
  'summary',
  'learner',
  'tutorGuide',
  'difficultyGuide',
  'practiceGuide',
  'referenceGuide',
  'rubric',
  'appliesTo',
  'labGuide',
  'concepts',
]);
const CONCEPT_KEYS = new Set(['id', 'label', 'summary', 'prerequisites', 'dimension']);
const RUBRIC_KEYS = new Set(['id', 'label', 'description', 'dimension', 'examples']);
const EXAMPLE_KEYS = new Set(['observation', 'betterWay']);
const APPLIES_KEYS = new Set(['languages', 'toolchains']);
const ID_RULE = 'must be lowercase letters, digits, - or _, start with a letter and be at most 32 long';

type CourseErrorKind =
  | 'table'
  | 'unknown'
  | 'list'
  | 'empty'
  | 'too_long'
  | 'control'
  | 'tag'
  | 'id'
  | 'repeat'
  | 'dimension'
  | 'version'
  | 'schema'
  | 'size'
  | 'prerequisite'
  | 'cycle'
  | 'toolchain';

// `message` is the main process's English text; `min` / `max` are the
// bounds a `list` or `too_long` error broke.
export type CourseFieldError = { field: string; kind: CourseErrorKind; message: string; min?: number; max?: number };

type Errors = CourseFieldError[];

const report = (errors: Errors, field: string, kind: CourseErrorKind, rule: string, bounds: { min?: number; max?: number } = {}): null => {
  errors.push({ field, kind, message: `${field}: ${rule}`, ...bounds });
  return null;
};

const isTable = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const table = (value: unknown, allowed: Set<string>, field: string, errors: Errors) => {
  if (!isTable(value)) return report(errors, field, 'table', 'must be a table');
  for (const key of Object.keys(value)) if (!allowed.has(key)) report(errors, field ? `${field}.${key}` : key, 'unknown', 'is not a known field');
  return value;
};

const list = (value: unknown, field: string, min: number, max: number, errors: Errors) => {
  if (!Array.isArray(value) || value.length < min || value.length > max)
    return report(errors, field, 'list', `must be a list of ${min} to ${max} items`, { min, max });
  return value as unknown[];
};

// One piece of text, trimmed.
const text = (value: unknown, field: string, errors: Errors, max: number = COURSE_LIMITS.field) => {
  if (typeof value !== 'string' || !value.trim()) return report(errors, field, 'empty', 'must be a non-empty string');
  const trimmed = value.trim();
  if ([...trimmed].length > max) return report(errors, field, 'too_long', `must be at most ${max} characters`, { max });
  if (CONTROL_CHARS.test(trimmed)) return report(errors, field, 'control', 'must not contain control characters');
  if (PROMPT_TAG.test(trimmed)) return report(errors, field, 'tag', 'must not contain tags such as <work_package>');
  return trimmed;
};

// Every entry checked; null when any of them failed.
const each = <T>(values: unknown[] | null, check: (value: unknown, index: number) => T | null): T[] | null => {
  if (!values) return null;
  const checked = values.map(check);
  return checked.every((value) => value !== null) ? (checked as T[]) : null;
};

const guide = (value: unknown, field: string, errors: Errors) =>
  each(list(value, field, 1, COURSE_LIMITS.guideLines, errors), (line, index) => text(line, `${field}[${index}]`, errors, COURSE_LIMITS.guideLine));

const example = (value: unknown, field: string, errors: Errors): RubricExample | null => {
  const raw = table(value, EXAMPLE_KEYS, field, errors);
  if (!raw) return null;
  const observation = text(raw.observation, `${field}.observation`, errors);
  const betterWay = text(raw.betterWay, `${field}.betterWay`, errors);
  return observation !== null && betterWay !== null ? { observation, betterWay } : null;
};

const DIMENSION_RULE = `must be one of ${coursePack.COURSE_DIMENSIONS.join(', ')}`;

// Each item's id once; a repeat names the item that repeats it.
const uniqueIds = (items: { id: string }[], field: string, errors: Errors) => {
  const seen = new Set<string>();
  items.forEach((item, index) => {
    if (seen.has(item.id)) report(errors, `${field}[${index}].id`, 'repeat', `repeats "${item.id}"`);
    seen.add(item.id);
  });
};

const rubricItem = (value: unknown, field: string, errors: Errors): RubricItem | null => {
  const raw = table(value, RUBRIC_KEYS, field, errors);
  if (!raw) return null;
  const id = coursePack.isCourseId(raw.id) ? raw.id : report(errors, `${field}.id`, 'id', ID_RULE);
  const dimension = coursePack.COURSE_DIMENSIONS.includes(raw.dimension as coursePack.CourseDimension)
    ? (raw.dimension as coursePack.CourseDimension)
    : report(errors, `${field}.dimension`, 'dimension', DIMENSION_RULE);
  const label = text(raw.label, `${field}.label`, errors);
  const description = text(raw.description, `${field}.description`, errors);
  const examples =
    raw.examples === undefined
      ? undefined
      : each(list(raw.examples, `${field}.examples`, 1, COURSE_LIMITS.examples, errors), (entry, index) =>
          example(entry, `${field}.examples[${index}]`, errors),
        );
  if (id === null || label === null || description === null || dimension === null || examples === null) return null;
  const item: RubricItem = { id, label, description, dimension };
  if (examples) item.examples = examples;
  return item;
};

const rubric = (value: unknown, errors: Errors) => {
  const items = each(list(value, 'rubric', COURSE_LIMITS.minRubric, COURSE_LIMITS.maxRubric, errors), (entry, index) =>
    rubricItem(entry, `rubric[${index}]`, errors),
  );
  if (!items) return null;
  uniqueIds(items, 'rubric', errors);
  return items;
};

const concept = (value: unknown, field: string, errors: Errors): Concept | null => {
  const raw = table(value, CONCEPT_KEYS, field, errors);
  if (!raw) return null;
  const id = coursePack.isCourseId(raw.id) ? raw.id : report(errors, `${field}.id`, 'id', ID_RULE);
  const label = text(raw.label, `${field}.label`, errors, COURSE_LIMITS.conceptLabel);
  const summary = text(raw.summary, `${field}.summary`, errors, COURSE_LIMITS.conceptSummary);
  let prerequisites =
    raw.prerequisites === undefined
      ? []
      : each(list(raw.prerequisites, `${field}.prerequisites`, 0, COURSE_LIMITS.prerequisites, errors), (prerequisite, index) =>
          coursePack.isCourseId(prerequisite) ? prerequisite : report(errors, `${field}.prerequisites[${index}]`, 'id', ID_RULE),
        );
  if (prerequisites && new Set(prerequisites).size < prerequisites.length)
    prerequisites = report(errors, `${field}.prerequisites`, 'repeat', 'must not repeat an id');
  const dimension =
    raw.dimension === undefined || coursePack.COURSE_DIMENSIONS.includes(raw.dimension as coursePack.CourseDimension)
      ? (raw.dimension as coursePack.CourseDimension | undefined)
      : report(errors, `${field}.dimension`, 'dimension', DIMENSION_RULE);
  if (id === null || label === null || summary === null || prerequisites === null || dimension === null) return null;
  const item: Concept = { id, label, summary, prerequisites };
  if (dimension !== undefined) item.dimension = dimension;
  return item;
};

const concepts = (value: unknown, errors: Errors) => {
  const items = each(list(value, 'concepts', 1, COURSE_LIMITS.concepts, errors), (entry, index) => concept(entry, `concepts[${index}]`, errors));
  if (!items) return null;
  const before = errors.length;
  uniqueIds(items, 'concepts', errors);
  const ids = new Set(items.map((item) => item.id));
  items.forEach((item, index) =>
    item.prerequisites.forEach(
      (id, at) =>
        ids.has(id) || report(errors, `concepts[${index}].prerequisites[${at}]`, 'prerequisite', `names "${id}", which is not a concept of this pack`),
    ),
  );
  if (errors.length > before) return null;
  const cycle = coursePack.conceptCycle(items);
  if (cycle) return report(errors, `concepts[${items.findIndex((item) => item.id === cycle[0])}].prerequisites`, 'cycle', `form a cycle: ${cycle.join(' → ')}`);
  if (byteLength(items) > COURSE_LIMITS.conceptsBytes)
    return report(errors, 'concepts', 'size', 'must be at most 48 KB together', { max: COURSE_LIMITS.conceptsBytes });
  return items;
};

const byteLength = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

const appliesTo = (value: unknown, errors: Errors): CoursePack['appliesTo'] | null => {
  const raw = table(value, APPLIES_KEYS, 'appliesTo', errors);
  if (!raw) return null;
  const applies: NonNullable<CoursePack['appliesTo']> = {};
  let failed = false;
  if (raw.languages !== undefined) {
    const languages = each(list(raw.languages, 'appliesTo.languages', 1, COURSE_LIMITS.languages, errors), (language, index) =>
      coursePack.isCourseId(language) ? language : report(errors, `appliesTo.languages[${index}]`, 'id', ID_RULE),
    );
    if (languages) applies.languages = languages;
    else failed = true;
  }
  if (raw.toolchains !== undefined) {
    const toolchains = each(list(raw.toolchains, 'appliesTo.toolchains', 1, LAB_TOOLCHAINS.length, errors), (toolchain, index) =>
      isLabToolchain(toolchain) ? toolchain : report(errors, `appliesTo.toolchains[${index}]`, 'toolchain', `must be one of ${LAB_TOOLCHAINS.join(', ')}`),
    );
    if (toolchains && new Set(toolchains).size !== toolchains.length) report(errors, 'appliesTo.toolchains', 'repeat', 'repeats a toolchain');
    if (toolchains && new Set(toolchains).size === toolchains.length) applies.toolchains = toolchains;
    else failed = true;
  }
  return failed ? null : applies;
};

// Checks a parsed pack and lists every error. The pack is null when any
// field is wrong; otherwise its fields are in a fixed order, so equal
// content always hashes the same.
export const checkCourse = (value: unknown): { pack: CoursePack | null; errors: CourseFieldError[] } => {
  const errors: Errors = [];
  const raw = table(value, TOP_KEYS, '', errors);
  if (!raw) return { pack: null, errors };
  if (raw.schemaVersion !== coursePack.COURSE_SCHEMA_VERSION) report(errors, 'schemaVersion', 'schema', `must be ${coursePack.COURSE_SCHEMA_VERSION}`);
  if (!coursePack.isCourseId(raw.id)) report(errors, 'id', 'id', ID_RULE);
  const version = semverOrNull(raw.version) ?? report(errors, 'version', 'version', 'must be a version such as 1.0.0');
  const pack = {
    schemaVersion: coursePack.COURSE_SCHEMA_VERSION,
    id: raw.id,
    version,
    domain: text(raw.domain, 'domain', errors),
    title: text(raw.title, 'title', errors),
    summary: text(raw.summary, 'summary', errors),
    learner: text(raw.learner, 'learner', errors),
    tutorGuide: guide(raw.tutorGuide, 'tutorGuide', errors),
    difficultyGuide: guide(raw.difficultyGuide, 'difficultyGuide', errors),
    practiceGuide: guide(raw.practiceGuide, 'practiceGuide', errors),
    referenceGuide: text(raw.referenceGuide, 'referenceGuide', errors),
    rubric: rubric(raw.rubric, errors),
  } as CoursePack;
  if (raw.appliesTo !== undefined) pack.appliesTo = appliesTo(raw.appliesTo, errors) ?? undefined;
  if (raw.labGuide !== undefined) pack.labGuide = guide(raw.labGuide, 'labGuide', errors) ?? undefined;
  const skeleton = raw.concepts === undefined ? undefined : concepts(raw.concepts, errors);
  if (errors.length) return { pack: null, errors };
  if (byteLength(pack) > COURSE_LIMITS.packBytes)
    return { pack: null, errors: [{ field: 'pack', kind: 'size', message: 'The course pack is larger than 8 KB', max: COURSE_LIMITS.packBytes }] };
  // Last, so the size above is the rest of the pack's and every field before
  // it keeps its place in the hash.
  if (skeleton) pack.concepts = skeleton;
  return { pack, errors };
};
