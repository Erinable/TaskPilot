// Check steps: what one step runs and how its output is read, validated
// field by field. A step comes from this machine's settings, the
// repository's taskpilot.toml or a preset (merged in ./effective_steps.ts),
// and every one passes through here before anything runs.
//
// SECURITY: commands are argument arrays run through execFile, never a
// shell string (see ./verification.ts). Paths stay inside the repository.
import path from 'node:path';

import { CUSTOM_NAME, JSON_DIALECTS, PARSER_FORMATS, SEVERITIES } from '../../shared/check_steps.ts';
import { WorkspaceError, normalizeCommand, parseCommandLine } from './command_line.ts';
import type { CheckParser, JsonDialect, ParserFormat, Severity, StepId, StepKind } from '../../shared/check_steps.ts';
import type { CommandEntry, WorkspaceErrorCode } from './command_line.ts';
import type { LooseJson } from '../infrastructure/loose_json.ts';

export const STAGES = ['step', 'submit'] as const;

// When a step runs: `step` is manual, `submit` runs before QA.
export type CheckStage = (typeof STAGES)[number];

// One runnable step. `cwd` is relative to the repository root ('' is the
// root); its commands run there one after another, stopping at the first
// that fails. `label` names a custom step.
export type CheckStep = {
  id: StepId;
  label: string | null;
  commands: CommandEntry[];
  cwd: string;
  stage: CheckStage;
  blocking: boolean;
  parser: CheckParser;
  env: Record<string, string>;
  timeoutMs?: number;
};

// What a project file or a preset sets for a step; unset fields fall
// through to the layer below. `enabled: false` turns the step off.
export type StepPatch = Partial<Omit<CheckStep, 'id'>> & { enabled?: boolean };

// A whole step as workspace.json stores it.
export type StoredStep = Omit<CheckStep, 'id' | 'label'> & { enabled: boolean };

// Only tests ran before review by default, and they decided it.
export const STEP_DEFAULTS: Record<StepKind, { stage: CheckStage; blocking: boolean }> = {
  setup: { stage: 'step', blocking: false },
  build: { stage: 'step', blocking: false },
  format: { stage: 'step', blocking: false },
  lint: { stage: 'step', blocking: false },
  typecheck: { stage: 'step', blocking: false },
  test: { stage: 'submit', blocking: true },
  coverage: { stage: 'step', blocking: false },
};
export const CUSTOM_DEFAULTS = { stage: 'step', blocking: false } as const;

const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const MAX_ENV = 8;
const MAX_COMMANDS = 8;
const MAX_PATTERN = 500;
export const MIN_TIMEOUT_MS = 1000;
export const MAX_TIMEOUT_MS = 60 * 60 * 1000;
// eslint-disable-next-line no-control-regex
const hasControlChar = (value: string) => /[\0-\x1f]/.test(value);

// Every step error names the field at fault, e.g. `steps.lint.parser.format`.
export const stepError = (field: string, message: string, code: WorkspaceErrorCode = 'invalid_step'): never => {
  throw new WorkspaceError(`${field}: ${message}`, code, field);
};

export const defaultsFor = (id: StepId) => (id in STEP_DEFAULTS ? STEP_DEFAULTS[id as StepKind] : CUSTOM_DEFAULTS);

// A path relative to `field`'s base: no absolute paths, no `..`, no odd
// bytes. '' (or '.') is the base itself when `allowEmpty`.
export const normalizeRelativePath = (value: unknown, field: string, { allowEmpty = false } = {}): string => {
  if (typeof value !== 'string') return stepError(field, 'must be a relative path');
  const clean = value.trim().replace(/\/+$/, '');
  if (allowEmpty && (clean === '' || clean === '.')) return '';
  const parts = clean.split(/[\\/]/).filter((part) => part !== '.');
  if (
    !clean ||
    clean.length > 200 ||
    path.isAbsolute(clean) ||
    /^[A-Za-z]:/.test(clean) ||
    parts.some((part) => part === '..' || part === '') ||
    hasControlChar(clean)
  )
    return stepError(field, 'must stay inside the repository');
  return parts.join('/');
};

// One command: a typed line (tokenized, no shell), an argv array, or
// {command, args} as workspace.json stores it.
const toCommand = (value: unknown, field: string): CommandEntry => {
  try {
    const entry =
      typeof value === 'string'
        ? parseCommandLine(value, field)
        : Array.isArray(value)
          ? normalizeCommand({ command: value[0], args: value.slice(1) }, field)
          : normalizeCommand(value, field);
    return entry ?? stepError(field, 'is empty');
  } catch (error) {
    if (error instanceof WorkspaceError) throw new WorkspaceError(`${field}: ${error.message.replace(`${field} `, '')}`, error.code, field);
    throw error;
  }
};

export const normalizeCommands = (value: unknown, field: string): CommandEntry[] => {
  const list = typeof value === 'string' || (value && typeof value === 'object' && !Array.isArray(value)) ? [value] : value;
  if (!Array.isArray(list)) return stepError(field, 'must be a list of commands');
  // Each item is a command line, an argv array or {command, args}.
  if (list.length > MAX_COMMANDS) stepError(field, `allows at most ${MAX_COMMANDS} commands`);
  return list.map((item, index) => toCommand(item, `${field}[${index}]`));
};

const isFormat = (value: unknown): value is ParserFormat => PARSER_FORMATS.includes(value as ParserFormat);
const isDialect = (value: unknown): value is JsonDialect => JSON_DIALECTS.includes(value as JsonDialect);
const isSeverity = (value: unknown): value is Severity => SEVERITIES.includes(value as Severity);

const optionalPath = (value: unknown, field: string) => (value === undefined || value === null || value === '' ? null : normalizeRelativePath(value, field));

const regexParser = (raw: LooseJson, field: string): CheckParser => {
  const pattern = raw.pattern;
  if (typeof pattern !== 'string' || !pattern || pattern.length > MAX_PATTERN)
    return stepError(`${field}.pattern`, `must be a regular expression of at most ${MAX_PATTERN} characters`);
  try {
    new RegExp(pattern);
  } catch {
    return stepError(`${field}.pattern`, 'is not a valid regular expression');
  }
  const severity = raw.severity ?? 'error';
  if (!isSeverity(severity)) stepError(`${field}.severity`, 'must be error, warning or info');
  return { format: 'regex', pattern, severity };
};

// {format, path?, dialect?, pattern?, severity?}; a bare string is the format.
export const normalizeParser = (value: unknown, field: string): CheckParser => {
  const raw: LooseJson =
    typeof value === 'string'
      ? { format: value }
      : value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : stepError(field, 'must be a table with a format');
  const format = raw.format;
  if (!isFormat(format)) return stepError(`${field}.format`, `must be one of ${PARSER_FORMATS.join(', ')}`);
  if (format === 'tests' || format === 'exitcode') return { format };
  if (format === 'junit') return { format, path: normalizeRelativePath(raw.path, `${field}.path`) };
  if (format === 'sarif') return { format, path: optionalPath(raw.path, `${field}.path`) };
  if (format === 'json') {
    const dialect = raw.dialect ?? 'diagnostics';
    if (!isDialect(dialect)) stepError(`${field}.dialect`, `must be one of ${JSON_DIALECTS.join(', ')}`);
    return { format, dialect, path: optionalPath(raw.path, `${field}.path`) };
  }
  return regexParser(raw, field);
};

export const normalizeEnv = (value: unknown, field: string): Record<string, string> => {
  const variables: Record<string, string> = {};
  if (value === undefined || value === null) return variables;
  if (typeof value !== 'object' || Array.isArray(value)) return stepError(field, 'must be a table of NAME = "value"');
  const pairs = Object.entries(value);
  if (pairs.length > MAX_ENV) stepError(field, `sets more than ${MAX_ENV} variables`);
  for (const [name, text] of pairs) {
    if (!ENV_NAME.test(name) || name === 'PATH' || name.startsWith('NODE_OPTIONS') || typeof text !== 'string' || text.length > 500)
      stepError(`${field}.${name}`, 'is not allowed');
    variables[name] = text;
  }
  return variables;
};

export const normalizeTimeoutMs = (value: unknown, field: string): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS)
    return stepError(field, 'must be 1 s to 60 min');
  return value;
};

export const normalizeStage = (value: unknown, field: string): CheckStage =>
  STAGES.includes(value as CheckStage) ? (value as CheckStage) : stepError(field, 'must be step or submit');

export const normalizeBoolean = (value: unknown, field: string): boolean => (typeof value === 'boolean' ? value : stepError(field, 'must be true or false'));

export const isCustomName = (name: string) => CUSTOM_NAME.test(name);

export const normalizeLabel = (value: unknown, field: string): string | null => {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.trim().length > 40 || hasControlChar(value)) return stepError(field, 'must be text of at most 40 characters');
  return value.trim();
};

// The persisted form of a whole step, as workspace.json stores it:
// {commands, cwd, stage, blocking, parser, env, timeoutMs, enabled}.
// Unset stage and blocking take the step's defaults.
export const normalizeStoredStep = (value: unknown, id: StepId, field: string): StoredStep => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return stepError(field, 'must be an object');
  const raw = value as LooseJson;
  const enabled = raw.enabled === undefined ? true : normalizeBoolean(raw.enabled, `${field}.enabled`);
  const commands = raw.commands === undefined && !enabled ? [] : normalizeCommands(raw.commands, `${field}.commands`);
  if (enabled && !commands.length) stepError(`${field}.commands`, 'needs at least one command');
  const defaults = defaultsFor(id);
  const step: StoredStep = {
    enabled,
    commands,
    cwd: raw.cwd === undefined ? '' : normalizeRelativePath(raw.cwd, `${field}.cwd`, { allowEmpty: true }),
    stage: raw.stage === undefined || raw.stage === null ? defaults.stage : normalizeStage(raw.stage, `${field}.stage`),
    blocking: raw.blocking === undefined || raw.blocking === null ? defaults.blocking : normalizeBoolean(raw.blocking, `${field}.blocking`),
    parser: raw.parser === undefined || raw.parser === null ? { format: 'tests' } : normalizeParser(raw.parser, `${field}.parser`),
    env: normalizeEnv(raw.env, `${field}.env`),
  };
  if (raw.timeoutMs !== undefined && raw.timeoutMs !== null) step.timeoutMs = normalizeTimeoutMs(raw.timeoutMs, `${field}.timeoutMs`);
  return step;
};
