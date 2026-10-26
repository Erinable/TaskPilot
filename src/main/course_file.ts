// A course pack file: `.taskpilot/courses/<id>.toml` in the repository.
// Parsed and validated field by field, in the style of ./project_config.ts;
// every error names its field, e.g. `rubric[1].dimension`.
//
//   schemaVersion = 1
//   id = "os"
//   version = "0.1.0"
//   domain = "operating-systems"
//   title = "操作系统实验"
//   summary = "..."
//   learner = "a student learning operating systems who can already write basic C"
//   tutorGuide = ["..."]           # 1 to 8 lines, each at most 300 characters
//   difficultyGuide = ["..."]
//   practiceGuide = ["..."]
//   referenceGuide = "..."
//   appliesTo = { languages = ["c", "rust"] }
//
//   [[rubric]]                     # 2 to 6 items
//   id = "concept"
//   label = "原理"
//   dimension = "thinking"         # thinking, writing or style
//   description = "..."
//   examples = [{ observation = "...", betterWay = "..." }]   # at most 2
//
// SECURITY: a pack's text is told to Product Lead and Tutor as instructions,
// so it cannot be treated as plain data. Its reach is limited instead: fixed
// fields, length caps, no control characters and no tags like the ones the
// prompts use as data boundaries (<work_package>, </submission>). A
// repository's pack is only used after this machine confirmed its content
// hash (./courses.ts).
import { createHash } from 'node:crypto';
import { parse as parseToml, TomlError } from 'smol-toml';

import { WorkspaceError } from './command_line.ts';
import { semverOrNull } from './semver.ts';
import { CONTROL_CHARS } from './text_rules.ts';
import * as coursePack from '../shared/course_pack.ts';
import type { CoursePack, RubricExample, RubricItem } from '../shared/course_pack.ts';
import type { LooseJson } from './loose_json.ts';

const MAX_FIELD = 500;
const MAX_GUIDE_LINE = 300;
const MAX_GUIDE_LINES = 8;
const MIN_RUBRIC = 2;
const MAX_RUBRIC = 6;
const MAX_EXAMPLES = 2;
const MAX_LANGUAGES = 8;
// The pack's JSON, which is a little larger than its text in a prompt.
const MAX_PACK_BYTES = 8 * 1024;
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
]);
const RUBRIC_KEYS = new Set(['id', 'label', 'description', 'dimension', 'examples']);
const EXAMPLE_KEYS = new Set(['observation', 'betterWay']);
const APPLIES_KEYS = new Set(['languages']);
const ID_RULE = 'must be lowercase letters, digits, - or _, start with a letter and be at most 32 long';

const fail = (field: string, message: string): never => {
  throw new WorkspaceError(`${field}: ${message}`, 'invalid_course', field);
};

const isTable = (value: unknown): value is LooseJson => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const table = (value: unknown, allowed: Set<string>, field: string): LooseJson => {
  if (!isTable(value)) return fail(field, 'must be a table');
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(field ? `${field}.${key}` : key, 'is not a known field');
  return value;
};

const list = (value: unknown, field: string, min: number, max: number): unknown[] => {
  if (!Array.isArray(value) || value.length < min || value.length > max) return fail(field, `must be a list of ${min} to ${max} items`);
  return value;
};

// One piece of text, trimmed.
const text = (value: unknown, field: string, max = MAX_FIELD): string => {
  if (typeof value !== 'string' || !value.trim()) return fail(field, 'must be a non-empty string');
  const trimmed = value.trim();
  if ([...trimmed].length > max) fail(field, `must be at most ${max} characters`);
  if (CONTROL_CHARS.test(trimmed)) fail(field, 'must not contain control characters');
  if (PROMPT_TAG.test(trimmed)) fail(field, 'must not contain tags such as <work_package>');
  return trimmed;
};

const guide = (value: unknown, field: string) => list(value, field, 1, MAX_GUIDE_LINES).map((line, index) => text(line, `${field}[${index}]`, MAX_GUIDE_LINE));

const example = (value: unknown, field: string): RubricExample => {
  const raw = table(value, EXAMPLE_KEYS, field);
  return { observation: text(raw.observation, `${field}.observation`), betterWay: text(raw.betterWay, `${field}.betterWay`) };
};

const rubricItem = (value: unknown, field: string): RubricItem => {
  const raw = table(value, RUBRIC_KEYS, field);
  if (!coursePack.isCourseId(raw.id)) fail(`${field}.id`, ID_RULE);
  if (!coursePack.COURSE_DIMENSIONS.includes(raw.dimension)) fail(`${field}.dimension`, `must be one of ${coursePack.COURSE_DIMENSIONS.join(', ')}`);
  const item: RubricItem = {
    id: raw.id,
    label: text(raw.label, `${field}.label`),
    description: text(raw.description, `${field}.description`),
    dimension: raw.dimension,
  };
  if (raw.examples !== undefined)
    item.examples = list(raw.examples, `${field}.examples`, 1, MAX_EXAMPLES).map((entry, index) => example(entry, `${field}.examples[${index}]`));
  return item;
};

const rubric = (value: unknown): RubricItem[] => {
  const items = list(value, 'rubric', MIN_RUBRIC, MAX_RUBRIC).map((entry, index) => rubricItem(entry, `rubric[${index}]`));
  const seen = new Set<string>();
  items.forEach((item, index) => {
    if (seen.has(item.id)) fail(`rubric[${index}].id`, `repeats "${item.id}"`);
    seen.add(item.id);
  });
  return items;
};

const appliesTo = (value: unknown): CoursePack['appliesTo'] => {
  const raw = table(value, APPLIES_KEYS, 'appliesTo');
  if (raw.languages === undefined) return {};
  const languages = list(raw.languages, 'appliesTo.languages', 1, MAX_LANGUAGES);
  languages.forEach((language, index) => coursePack.isCourseId(language) || fail(`appliesTo.languages[${index}]`, ID_RULE));
  return { languages: languages as string[] };
};

// Validates a parsed pack. The result has its fields in a fixed order, so
// equal content always hashes the same.
export const normalizeCourse = (value: unknown): CoursePack => {
  const raw = table(value, TOP_KEYS, '');
  if (raw.schemaVersion !== coursePack.COURSE_SCHEMA_VERSION) fail('schemaVersion', `must be ${coursePack.COURSE_SCHEMA_VERSION}`);
  if (!coursePack.isCourseId(raw.id)) fail('id', ID_RULE);
  const pack: CoursePack = {
    schemaVersion: coursePack.COURSE_SCHEMA_VERSION,
    id: raw.id,
    version: semverOrNull(raw.version) ?? fail('version', 'must be a version such as 1.0.0'),
    domain: text(raw.domain, 'domain'),
    title: text(raw.title, 'title'),
    summary: text(raw.summary, 'summary'),
    learner: text(raw.learner, 'learner'),
    tutorGuide: guide(raw.tutorGuide, 'tutorGuide'),
    difficultyGuide: guide(raw.difficultyGuide, 'difficultyGuide'),
    practiceGuide: guide(raw.practiceGuide, 'practiceGuide'),
    referenceGuide: text(raw.referenceGuide, 'referenceGuide'),
    rubric: rubric(raw.rubric),
  };
  if (raw.appliesTo !== undefined) pack.appliesTo = appliesTo(raw.appliesTo);
  if (Buffer.byteLength(JSON.stringify(pack)) > MAX_PACK_BYTES) throw new WorkspaceError('The course pack is larger than 8 KB', 'invalid_course', 'pack');
  return pack;
};

// Parses a file's text; a syntax error names its line and column.
export const parseCourse = (text: string): CoursePack => {
  let value: unknown;
  try {
    value = parseToml(text);
  } catch (error) {
    if (error instanceof TomlError)
      throw new WorkspaceError(`line ${error.line}, column ${error.column}: ${error.message.split('\n')[0]}`, 'invalid_course', 'toml');
    throw error;
  }
  return normalizeCourse(value);
};

// What a confirmation is given for: the validated content, so only a change
// the agents would see asks again.
export const contentHash = (pack: CoursePack) => createHash('sha256').update(JSON.stringify(pack)).digest('hex');
