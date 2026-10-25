// Workspace configuration: the repository TaskPilot observes and the commands
// it is allowed to run for verification.
//
// SECURITY: verification commands are the only commands TaskPilot executes, and
// they come from this file alone — never from work package data. Work packages
// are authored by AI agents; treating a command in one as executable would turn
// agent output into arbitrary code execution on the developer's machine.
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';

import { env } from './env.ts';
import { jsonText, writeFileAtomic } from './atomic_json_file.ts';
import type { LooseJson } from './loose_json.ts';

// Report paths must not contain C0 controls.
// eslint-disable-next-line no-control-regex
const hasControlChar = (value: string) => /[\0-\x1f]/.test(value);

export const CONFIG_FILENAME = 'workspace.json';
export const CONFIG_VERSION = 2;
// Fixed check slots. `test` holds the unit tests; `smoke` runs after a build.
export const COMMAND_KINDS = ['test', 'lint', 'build', 'smoke'] as const;
export const STAGES = ['step', 'submit'] as const;
const REPORT_FORMATS = ['stdout', 'junit'] as const;

// One of the fixed check slots.
export type CheckKind = (typeof COMMAND_KINDS)[number];
// When a check runs: `step` is manual, `submit` runs before QA.
export type CheckStage = (typeof STAGES)[number];
export type ReportFormat = (typeof REPORT_FORMATS)[number];

// Where a check's results are read from.
export type CheckReport = { format: 'stdout' } | { format: 'junit'; path: string };

// An executable plus its argument array; never a shell string.
export interface CommandEntry {
  command: string;
  args: string[];
}

// A configured verification check.
export interface Check extends CommandEntry {
  stage: CheckStage;
  blocking: boolean;
  report: CheckReport;
  env: Record<string, string>;
  timeoutMs?: number;
}

// A normalized workspace.json. `commands` is the derived {command, args} view.
export interface WorkspaceConfig {
  version: number;
  root: string | null;
  checks: Record<CheckKind, Check | null>;
  commands: Record<CheckKind, CommandEntry | null>;
}

// The persisted shape of workspace.json.
export interface SerializedWorkspaceConfig {
  version: number;
  root: string | null;
  checks: Record<CheckKind, Check | null>;
}

// Per-kind options the settings form shows.
export interface CheckFormOptions {
  stage: CheckStage;
  blocking: boolean;
  reportPath: string;
}

// What the settings form edits.
export interface WorkspaceForm {
  root: string;
  commands: Record<CheckKind, string>;
  options: Record<CheckKind, CheckFormOptions>;
}

// The form as it arrives from the renderer: untrusted and possibly partial.
export interface WorkspaceFormInput {
  root?: unknown;
  commands?: Partial<Record<CheckKind, unknown>>;
  options?: Partial<Record<CheckKind, { stage?: unknown; blocking?: unknown; reportPath?: unknown }>>;
}

export type WorkspaceErrorCode = 'invalid_report' | 'invalid_check' | 'invalid_command' | 'unterminated_quote' | 'shell_syntax' | 'invalid_json';

// Defaults keep a v1 config behaving exactly as before: only tests ran
// before review, and they decided it.
export const CHECK_DEFAULTS: Record<CheckKind, { stage: CheckStage; blocking: boolean }> = {
  test: { stage: 'submit', blocking: true },
  lint: { stage: 'step', blocking: false },
  build: { stage: 'step', blocking: false },
  smoke: { stage: 'submit', blocking: true },
};
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const MAX_ENV = 8;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 60 * 60 * 1000;

// Unquoted tokens a user might type expecting shell behaviour. They would
// reach the program as literal arguments and fail confusingly, so they are
// rejected with a pointer to package.json scripts instead.
const SHELL_OPERATORS = new Set(['&&', '||', '|', ';', '&', '>', '>>', '<', '2>', '2>&1', '&>']);

export class WorkspaceError extends Error {
  code: WorkspaceErrorCode;
  field?: string;

  // `field` names the settings input at fault ('root' or a command kind).
  constructor(message: string, code: WorkspaceErrorCode, field?: string) {
    super(message);
    this.name = 'WorkspaceError';
    this.code = code;
    if (field) this.field = field;
  }
}

export const emptyConfig = (): WorkspaceConfig => {
  const checks = Object.fromEntries(COMMAND_KINDS.map((kind) => [kind, null])) as Record<CheckKind, null>;
  return { version: CONFIG_VERSION, root: null, checks, commands: { ...checks } };
};

// A workspace-relative report path: no absolute paths, no `..`, no odd bytes.
export const normalizeReportPath = (value: unknown, kind: string): string => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new WorkspaceError(`${kind} junit report needs a path`, 'invalid_report', kind);
  }
  const clean = value.trim();
  const parts = clean.split(/[\\/]/);
  if (clean.length > 200 || path.isAbsolute(clean) || /^[A-Za-z]:/.test(clean) || parts.some((part) => part === '..' || part === '') || hasControlChar(clean)) {
    throw new WorkspaceError(`${kind} report path must stay inside the workspace`, 'invalid_report', kind);
  }
  return parts.join('/');
};

const isStage = (value: unknown): value is CheckStage => STAGES.includes(value as CheckStage);
const isReportFormat = (value: unknown): value is ReportFormat => REPORT_FORMATS.includes(value as ReportFormat);

const normalizeCheckEnv = (value: unknown, kind: CheckKind): Record<string, string> => {
  const variables: Record<string, string> = {};
  if (value === undefined || value === null) return variables;
  if (typeof value !== 'object' || Array.isArray(value)) throw new WorkspaceError(`${kind} env must be an object`, 'invalid_check', kind);
  const pairs = Object.entries(value);
  if (pairs.length > MAX_ENV) throw new WorkspaceError(`${kind} sets too many environment variables`, 'invalid_check', kind);
  for (const [name, text] of pairs) {
    if (!ENV_NAME.test(name) || name === 'PATH' || name.startsWith('NODE_OPTIONS') || typeof text !== 'string' || text.length > 500)
      throw new WorkspaceError(`${kind} env ${name} is not allowed`, 'invalid_check', kind);
    variables[name] = text;
  }
  return variables;
};

// A check is a verification command plus when it runs and whether it can
// reject a review on its own. Like a bare command it is user configuration
// only; nothing here ever comes from a work package or an agent.
export const normalizeCheck = (value: unknown, kind: CheckKind): Check | null => {
  if (value === null || value === undefined) return null;
  // Non-null: value is neither null nor undefined here.
  const entry = normalizeCommand(value, kind) as CommandEntry;
  // normalizeCommand() has checked that value is a plain object.
  const raw = value as LooseJson;
  const defaults = CHECK_DEFAULTS[kind];
  const stage = raw.stage ?? defaults.stage;
  if (!isStage(stage)) throw new WorkspaceError(`${kind} stage must be step or submit`, 'invalid_check', kind);
  const blocking = raw.blocking ?? defaults.blocking;
  if (typeof blocking !== 'boolean') throw new WorkspaceError(`${kind} blocking must be true or false`, 'invalid_check', kind);

  const format = raw.report?.format ?? 'stdout';
  if (!isReportFormat(format)) throw new WorkspaceError(`${kind} report format is not supported`, 'invalid_report', kind);
  const report: CheckReport = format === 'junit' ? { format, path: normalizeReportPath(raw.report.path, kind) } : { format };

  const env = normalizeCheckEnv(raw.env, kind);

  const check: Check = { ...entry, stage, blocking, report, env };
  if (raw.timeoutMs !== undefined && raw.timeoutMs !== null) {
    if (!Number.isInteger(raw.timeoutMs) || raw.timeoutMs < MIN_TIMEOUT_MS || raw.timeoutMs > MAX_TIMEOUT_MS) {
      throw new WorkspaceError(`${kind} timeout must be 1 s to 60 min`, 'invalid_check', kind);
    }
    check.timeoutMs = raw.timeoutMs;
  }
  return check;
};

// A command is stored as {command, args} — an executable plus an argument
// array, never a shell string. This keeps execution off the shell so nothing
// in the configured values can be interpreted as an operator.
export const normalizeCommand = (value: unknown, kind: string): CommandEntry | null => {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkspaceError(`${kind} command must be an object`, 'invalid_command', kind);
  }
  const { command, args = [] } = value as { command?: unknown; args?: unknown };
  if (typeof command !== 'string' || !command.trim()) {
    throw new WorkspaceError(`${kind} command is missing an executable`, 'invalid_command', kind);
  }
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
    throw new WorkspaceError(`${kind} command args must be strings`, 'invalid_command', kind);
  }
  return { command: command.trim(), args: [...args] };
};

// Splits a command line typed in settings into {command, args}.
//
// This is a tokenizer, not a shell: quotes group words and backslashes escape,
// but nothing is expanded, substituted, or executed. Returns null for a blank
// line, which means "not configured".
type CommandToken = { value: string; quoted: boolean };

const commandFromTokens = (tokens: CommandToken[], kind: string): CommandEntry | null => {
  if (tokens.length === 0) return null;
  const operator = tokens.find((token) => !token.quoted && SHELL_OPERATORS.has(token.value));
  if (operator) throw new WorkspaceError(`${kind} command uses shell syntax "${operator.value}"`, 'shell_syntax', kind);
  const [command, ...args] = tokens.map((token) => token.value);
  return normalizeCommand({ command, args }, kind);
};

export const parseCommandLine = (text: unknown, kind: string): CommandEntry | null => {
  if (text === null || text === undefined) return null;
  if (typeof text !== 'string') {
    throw new WorkspaceError(`${kind} command must be text`, 'invalid_command', kind);
  }

  const tokens: CommandToken[] = [];
  let value = '';
  let inToken = false;
  let quoted = false; // any part of the current token was quoted or escaped
  let quote: string | null = null;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else value += ch;
    } else if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === '\\' && (text[i + 1] === '"' || text[i + 1] === '\\')) value += text[++i];
      else value += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      inToken = true;
      quoted = true;
    } else if (ch === '\\' && i + 1 < text.length) {
      value += text[++i];
      inToken = true;
      quoted = true;
    } else if (/\s/.test(ch)) {
      if (inToken) tokens.push({ value, quoted });
      value = '';
      inToken = false;
      quoted = false;
    } else {
      value += ch;
      inToken = true;
    }
  }

  if (quote) {
    throw new WorkspaceError(`${kind} command has an unterminated ${quote} quote`, 'unterminated_quote', kind);
  }
  if (inToken) tokens.push({ value, quoted });
  return commandFromTokens(tokens, kind);
};

// Inverse of parseCommandLine(), quoting only where needed.
export const formatCommandLine = (entry: CommandEntry | null | undefined): string => {
  if (!entry) return '';
  return [entry.command, ...entry.args]
    .map((token) => (token === '' || /[\s'"\\]/.test(token) || SHELL_OPERATORS.has(token) ? `'${token.replace(/'/g, "'\\''")}'` : token))
    .join(' ');
};

// Turns the settings form into a config. `commands` holds one typed line per
// kind; `options` (optional) holds {stage, blocking, reportPath} per kind.
// Settings the form does not show (env, timeout) are kept from `previous`.
const reportFromForm = (value: unknown, previous: CheckReport | undefined): CheckReport | undefined => {
  const reportPath = typeof value === 'string' ? value.trim() : null;
  if (reportPath === null) return previous;
  return reportPath ? { format: 'junit', path: reportPath } : { format: 'stdout' };
};

export const fromForm = (form: WorkspaceFormInput | null | undefined, previous: WorkspaceConfig | null = null): WorkspaceConfig => {
  const checks: Record<string, unknown> = {};
  for (const kind of COMMAND_KINDS) {
    const entry = parseCommandLine(form?.commands?.[kind], kind);
    if (!entry) {
      checks[kind] = null;
      continue;
    }
    const options = form?.options?.[kind] ?? {};
    const kept = previous?.checks?.[kind];
    checks[kind] = {
      ...entry,
      stage: options.stage ?? kept?.stage,
      blocking: options.blocking ?? kept?.blocking,
      report: reportFromForm(options.reportPath, kept?.report),
      env: kept?.env,
      timeoutMs: kept?.timeoutMs,
    };
  }
  return normalize({ root: form?.root, checks });
};

// What the settings form edits, the inverse of fromForm().
export const toForm = (config: WorkspaceConfig): WorkspaceForm => {
  const commands = {} as Record<CheckKind, string>;
  const options = {} as Record<CheckKind, CheckFormOptions>;
  for (const kind of COMMAND_KINDS) {
    const check = config.checks[kind];
    commands[kind] = formatCommandLine(check);
    options[kind] = check
      ? { stage: check.stage, blocking: check.blocking, reportPath: check.report.format === 'junit' ? check.report.path : '' }
      : { ...CHECK_DEFAULTS[kind], reportPath: '' };
  }
  return { root: config.root ?? '', commands, options };
};

// Finds the file `command` would launch, the way execFile does: through PATH
// for a bare name, relative to `cwd` for a path. Returns null when nothing
// executable is found, so settings can warn before a run fails.
export const resolveExecutable = async (
  command: string,
  {
    cwd = null,
    envPath = env.path,
    platform = process.platform,
    pathExt = env.pathExt,
  }: { cwd?: string | null; envPath?: string; platform?: NodeJS.Platform; pathExt?: string } = {},
): Promise<string | null> => {
  const extensions = platform === 'win32' ? ['', ...(pathExt ?? '.EXE;.CMD;.BAT').split(';')] : [''];
  const isPath = command.includes('/') || (platform === 'win32' && command.includes('\\'));
  const bases: string[] = [];
  if (isPath) {
    if (path.isAbsolute(command)) bases.push(command);
    else if (cwd) bases.push(path.resolve(cwd, command));
  } else {
    for (const dir of envPath.split(path.delimiter).filter(Boolean)) bases.push(path.join(dir, command));
  }

  for (const base of bases) {
    for (const extension of extensions) {
      const candidate = base + extension;
      try {
        if (!(await fs.stat(candidate)).isFile()) continue;
        await fs.access(candidate, fsConstants.X_OK);
        return candidate;
      } catch {
        // Not here; keep looking.
      }
    }
  }
  return null;
};

// Accepts a v2 config ({checks}) or a v1 one ({commands}); v1 commands get
// the defaults for their kind. `commands` is kept on the result as a plain
// {command, args} view for callers that only run a command.
export const normalize = (input: unknown): WorkspaceConfig => {
  const config = emptyConfig();
  if (input && typeof input === 'object') {
    const raw = input as LooseJson;
    if (typeof raw.root === 'string' && raw.root.trim()) config.root = raw.root.trim();
    const source = raw.checks && typeof raw.checks === 'object' ? raw.checks : raw.commands;
    for (const kind of COMMAND_KINDS) {
      const check = normalizeCheck(source?.[kind], kind);
      config.checks[kind] = check;
      config.commands[kind] = check && { command: check.command, args: [...check.args] };
    }
  }
  return config;
};

// The persisted shape: `commands` is derived, so it is not written.
export const serialize = (config: WorkspaceConfig): SerializedWorkspaceConfig => ({ version: CONFIG_VERSION, root: config.root, checks: config.checks });

export const load = async (configDir: string): Promise<WorkspaceConfig> => {
  const file = path.join(configDir, CONFIG_FILENAME);
  try {
    return normalize(JSON.parse(await fs.readFile(file, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyConfig();
    if (error instanceof SyntaxError) {
      throw new WorkspaceError(`${CONFIG_FILENAME} is not valid JSON`, 'invalid_json');
    }
    throw error;
  }
};

export const save = async (configDir: string, raw: unknown): Promise<WorkspaceConfig> => {
  const config = normalize(raw);
  await fs.mkdir(configDir, { recursive: true });
  const file = path.join(configDir, CONFIG_FILENAME);
  // Through a temp file, so a crash mid-write leaves the previous config.
  await writeFileAtomic(file, jsonText(serialize(config)));
  return config;
};

// True when `candidate` is inside `root`. Used to keep file reads and the
// work package file scope from escaping the workspace via `../`.
export const isInside = (root: string, candidate: string): boolean => {
  const relative = path.relative(path.resolve(root), path.resolve(root, candidate));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
};
