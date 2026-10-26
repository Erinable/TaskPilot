// The repository's own check configuration: `taskpilot.toml` at its root.
// It names a preset and overrides or turns off any step; this machine's
// settings still win over it (./effective_steps.ts).
//
//   preset = "typescript"            # or "none"
//   course = "programming"           # the course pack (./courses.ts)
//
//   [steps.lint]
//   commands = ["npm run lint"]      # one or more, run in order
//   cwd = "."                        # relative to the repository root
//   timeout = 600                    # seconds
//   required = true                  # a failure rejects the review
//   stage = "submit"                 # or "manual"
//   parser = { format = "json", dialect = "eslint" }
//
//   [steps.coverage]
//   enabled = false
//
//   [custom.complexity]              # a project's own step
//   label = "复杂度"
//   commands = ["node scripts/analyze_complexity.ts --check"]
//
//   [[labs]]                         # a course lab repository's labs,
//   id = "round-robin"               # written by TaskPilot (./lab_service.ts)
//   stage = 1
//   dir = "labs/01-round-robin"
//   concepts = ["round-robin"]
//
// SECURITY: the file is the repository's, like its package.json scripts,
// and is read from the working tree whenever steps are needed. A Coding
// Agent patch that touches it is high-risk and stops for the developer
// (./coding_workspace.ts). Every command is an argument array run without a
// shell.
import fs from 'node:fs/promises';
import path from 'node:path';
import { parse as parseToml, TomlError } from 'smol-toml';

import { WorkspaceError } from './command_line.ts';
import { CUSTOM_PREFIX, STEP_KINDS, isStepKind } from '../shared/check_steps.ts';
import * as stepConfig from './step_config.ts';
import { isCourseId } from '../shared/course_pack.ts';
import type { StepId } from '../shared/check_steps.ts';
import type { StepPatch } from './step_config.ts';
import type { LooseJson } from './loose_json.ts';

export const PROJECT_FILENAME = 'taskpilot.toml';
export const PROJECT_VERSION = 1;
const MAX_PROJECT_BYTES = 64 * 1024;
const MAX_CUSTOM = 16;
const MAX_LABS = 32;
const MAX_LAB_CONCEPTS = 8;

// One lab of a course lab repository. Stages count from 1 and are unique;
// `dir` holds the lab's README.
export type LabEntry = { id: string; stage: number; dir: string; concepts: string[] };

// The file's validated content. `preset` is null when the file names none
// ("none" or left out), `course` when it names no course pack. `labs` is
// empty outside a lab repository, and in files from before labs existed.
export type ProjectFile = { preset: string | null; course: string | null; labs: LabEntry[]; steps: Partial<Record<StepId, StepPatch>> };

// [人工决策-2026-10-26 15:38:21] 课程包按仓库选：顶层 course 随仓库提交，本机 workspace.json 可覆盖。
const TOP_KEYS = new Set(['version', 'preset', 'course', 'labs', 'steps', 'custom']);
const LAB_KEYS = new Set(['id', 'stage', 'dir', 'concepts']);
// Lab ids; concepts are a pack's ids, or `ai:` nodes of the course plan.
const LAB_ID = /^[a-z][a-z0-9-]{0,39}$/;
export const isLabId = (value: unknown): value is string => typeof value === 'string' && LAB_ID.test(value);
export const isLabConcept = (value: unknown): value is string => typeof value === 'string' && isCourseId(value.replace(/^ai:/, ''));
const STEP_KEYS = new Set(['enabled', 'commands', 'cwd', 'timeout', 'required', 'stage', 'parser', 'env']);
const CUSTOM_KEYS = new Set([...STEP_KEYS, 'label']);
const PARSER_KEYS = new Set(['format', 'path', 'dialect', 'pattern', 'severity']);
const STAGE_NAMES: Record<string, string> = { submit: 'submit', manual: 'step' };

const isTable = (value: unknown): value is LooseJson => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const onlyKeys = (table: LooseJson, allowed: Set<string>, field: string) => {
  for (const key of Object.keys(table)) if (!allowed.has(key)) stepConfig.stepError(field ? `${field}.${key}` : key, 'is not a known field', 'invalid_project');
};

// Field errors from the step validators carry the project's own names.
const asProjectError = (error: unknown): never => {
  if (error instanceof WorkspaceError) throw new WorkspaceError(error.message, 'invalid_project', error.field);
  throw error;
};

const seconds = (value: unknown, field: string) => {
  if (typeof value !== 'number' || !Number.isInteger(value)) stepConfig.stepError(field, 'must be whole seconds, 1 to 3600');
  return stepConfig.normalizeTimeoutMs((value as number) * 1000, field);
};

const stage = (value: unknown, field: string) => {
  if (typeof value !== 'string' || !Object.hasOwn(STAGE_NAMES, value)) stepConfig.stepError(field, 'must be submit or manual');
  return stepConfig.normalizeStage(STAGE_NAMES[value as string], field);
};

const parser = (value: unknown, field: string) => {
  if (isTable(value)) onlyKeys(value, PARSER_KEYS, field);
  return stepConfig.normalizeParser(value, field);
};

const commands = (value: unknown, field: string) => {
  const list = stepConfig.normalizeCommands(value, field);
  return list.length ? list : stepConfig.stepError(field, 'needs at least one command');
};

// The schema of a step table: each TOML key, the step field it sets and its
// validator. `label` is only read for custom steps.
const STEP_FIELDS: { key: string; target: keyof StepPatch; read: (value: unknown, field: string) => unknown }[] = [
  { key: 'enabled', target: 'enabled', read: stepConfig.normalizeBoolean },
  { key: 'commands', target: 'commands', read: commands },
  { key: 'cwd', target: 'cwd', read: (value, field) => stepConfig.normalizeRelativePath(value, field, { allowEmpty: true }) },
  { key: 'timeout', target: 'timeoutMs', read: seconds },
  { key: 'required', target: 'blocking', read: stepConfig.normalizeBoolean },
  { key: 'stage', target: 'stage', read: stage },
  { key: 'parser', target: 'parser', read: parser },
  { key: 'env', target: 'env', read: stepConfig.normalizeEnv },
  { key: 'label', target: 'label', read: stepConfig.normalizeLabel },
];

// One [steps.<kind>] or [custom.<name>] table. Fields left out stay unset,
// so the preset or this machine fills them.
const toPatch = (table: unknown, field: string, custom: boolean): StepPatch => {
  if (!isTable(table)) return stepConfig.stepError(field, 'must be a table', 'invalid_project');
  onlyKeys(table, custom ? CUSTOM_KEYS : STEP_KEYS, field);
  const patch: Record<string, unknown> = {};
  try {
    for (const { key, target, read } of STEP_FIELDS) if (table[key] !== undefined) patch[target] = read(table[key], `${field}.${key}`);
  } catch (error) {
    asProjectError(error);
  }
  // A custom step is the project's own: it has nothing to fall back on.
  if (custom && patch.enabled !== false && !patch.commands) stepConfig.stepError(`${field}.commands`, 'needs at least one command', 'invalid_project');
  return patch as StepPatch;
};

const labEntry = (value: unknown, field: string): LabEntry => {
  if (!isTable(value)) return stepConfig.stepError(field, 'must be a table', 'invalid_project');
  onlyKeys(value, LAB_KEYS, field);
  if (!isLabId(value.id)) stepConfig.stepError(`${field}.id`, 'must be lowercase letters, digits or -, starting with a letter', 'invalid_project');
  if (!Number.isInteger(value.stage) || value.stage < 1 || value.stage > MAX_LABS)
    stepConfig.stepError(`${field}.stage`, `must be a whole number from 1 to ${MAX_LABS}`, 'invalid_project');
  let dir = '';
  try {
    dir = stepConfig.normalizeRelativePath(value.dir, `${field}.dir`);
  } catch (error) {
    asProjectError(error);
  }
  const concepts = value.concepts ?? [];
  if (!Array.isArray(concepts) || concepts.length > MAX_LAB_CONCEPTS || !concepts.every(isLabConcept))
    stepConfig.stepError(`${field}.concepts`, `must be at most ${MAX_LAB_CONCEPTS} concept ids`, 'invalid_project');
  return { id: value.id, stage: value.stage, dir, concepts: [...new Set(concepts as string[])] };
};

const labEntries = (value: unknown): LabEntry[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return stepConfig.stepError('labs', 'must be a list of [[labs]] tables', 'invalid_project');
  if (value.length > MAX_LABS) stepConfig.stepError('labs', `allows at most ${MAX_LABS} labs`, 'invalid_project');
  const labs = value.map((entry, index) => labEntry(entry, `labs[${index}]`));
  labs.forEach((lab, index) => {
    if (labs.findIndex((other) => other.id === lab.id) !== index) stepConfig.stepError(`labs[${index}].id`, `repeats "${lab.id}"`, 'invalid_project');
    if (labs.findIndex((other) => other.stage === lab.stage) !== index)
      stepConfig.stepError(`labs[${index}].stage`, `repeats stage ${lab.stage}`, 'invalid_project');
  });
  return labs;
};

// Validates a parsed file. Every error names its field, e.g.
// `steps.lint.parser.format`, and `presets` lists the names `preset` may take.
export const normalizeProject = (value: unknown, presets: readonly string[]): ProjectFile => {
  if (!isTable(value)) return stepConfig.stepError('', 'must be a table', 'invalid_project');
  onlyKeys(value, TOP_KEYS, '');
  if (value.version !== undefined && value.version !== PROJECT_VERSION) stepConfig.stepError('version', `must be ${PROJECT_VERSION}`, 'invalid_project');
  const preset = value.preset ?? 'none';
  if (preset !== 'none' && !presets.includes(preset)) stepConfig.stepError('preset', `must be one of ${[...presets, 'none'].join(', ')}`, 'invalid_project');
  // Only the form here: which packs exist depends on the repository's files.
  if (value.course !== undefined && !isCourseId(value.course))
    stepConfig.stepError('course', 'must be a course pack id such as "programming"', 'invalid_project');
  const steps: ProjectFile['steps'] = {};
  if (value.steps !== undefined) {
    if (!isTable(value.steps)) stepConfig.stepError('steps', 'must be a table', 'invalid_project');
    for (const [kind, table] of Object.entries(value.steps as LooseJson)) {
      if (!isStepKind(kind))
        stepConfig.stepError(`steps.${kind}`, `is not a step; use one of ${STEP_KINDS.join(', ')}, or [custom.${kind}]`, 'invalid_project');
      steps[kind as StepId] = toPatch(table, `steps.${kind}`, false);
    }
  }
  if (value.custom !== undefined) {
    if (!isTable(value.custom)) stepConfig.stepError('custom', 'must be a table', 'invalid_project');
    const names = Object.keys(value.custom as LooseJson);
    if (names.length > MAX_CUSTOM) stepConfig.stepError('custom', `allows at most ${MAX_CUSTOM} steps`, 'invalid_project');
    for (const name of names) {
      if (!stepConfig.isCustomName(name)) stepConfig.stepError(`custom.${name}`, 'must be lowercase letters, digits, - or _', 'invalid_project');
      steps[`${CUSTOM_PREFIX}${name}`] = toPatch((value.custom as LooseJson)[name], `custom.${name}`, true);
    }
  }
  return { preset: preset === 'none' ? null : preset, course: value.course ?? null, labs: labEntries(value.labs), steps };
};

// Parses the file's text; a syntax error names its line and column.
export const parseProject = (text: string, presets: readonly string[]): ProjectFile => {
  let value: unknown;
  try {
    value = parseToml(text);
  } catch (error) {
    if (error instanceof TomlError)
      throw new WorkspaceError(`line ${error.line}, column ${error.column}: ${error.message.split('\n')[0]}`, 'invalid_project', 'toml');
    throw error;
  }
  return normalizeProject(value, presets);
};

// The file's text, or null when the repository has none. Only a regular
// file directly in the root is read, never through a symlink.
export const readProjectText = async (root: string): Promise<string | null> => {
  const file = path.join(root, PROJECT_FILENAME);
  let stat;
  try {
    stat = await fs.lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile()) throw new WorkspaceError(`${PROJECT_FILENAME} must be a regular file`, 'invalid_project', 'toml');
  if (stat.size > MAX_PROJECT_BYTES) throw new WorkspaceError(`${PROJECT_FILENAME} is larger than 64 KB`, 'invalid_project', 'toml');
  return fs.readFile(file, 'utf8');
};

// Example command lines for the commented steps, from the preset's
// suggestions; null where the preset has none.
export type TemplateExamples = { lint: string | null; custom: string | null };

// What a new file says: the preset, and the shape of a step as comments.
export const projectTemplate = (preset: string, examples: TemplateExamples) =>
  [
    '# TaskPilot checks for this repository. Steps: setup, build, format, lint,',
    '# typecheck, test, coverage. The preset fills in every step not set here.',
    `preset = "${preset}"`,
    '',
    '# [steps.lint]',
    `# commands = [${JSON.stringify(examples.lint ?? '<command>')}]`,
    '# required = true',
    '# stage = "submit"   # or "manual"',
    '# parser = { format = "exitcode" }',
    '',
    '# [custom.name]',
    '# label = "My check"',
    `# commands = [${JSON.stringify(examples.custom ?? '<command>')}]`,
    '',
    '# The course pack TaskPilot teaches with: built in, or .taskpilot/courses/<id>.toml.',
    '# course = "programming"',
    '',
    '# A course lab repository lists its labs; TaskPilot writes them.',
    '# [[labs]]',
    '# id = "round-robin"',
    '# stage = 1',
    '# dir = "labs/01-round-robin"',
    '# concepts = ["round-robin"]',
    '',
  ].join('\n');

// Writes a new file; an existing one is never overwritten.
export const createProjectFile = async (root: string, preset: string, examples: TemplateExamples) => {
  const file = path.join(root, PROJECT_FILENAME);
  try {
    await fs.writeFile(file, projectTemplate(preset, examples), { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new WorkspaceError(`${PROJECT_FILENAME} already exists`, 'invalid_project', 'toml');
    throw error;
  }
};
