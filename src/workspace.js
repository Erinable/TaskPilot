// Workspace configuration: the repository TaskPilot observes and the commands
// it is allowed to run for verification.
//
// SECURITY: verification commands are the only commands TaskPilot executes, and
// they come from this file alone — never from work package data. Work packages
// are authored by AI agents; treating a command in one as executable would turn
// agent output into arbitrary code execution on the developer's machine.
const fs = require('node:fs/promises');
const { constants: fsConstants } = require('node:fs');
const path = require('node:path');

const CONFIG_FILENAME = 'workspace.json';
const CONFIG_VERSION = 2;
// Fixed check slots. `test` holds the unit tests; `smoke` runs after a build.
const COMMAND_KINDS = ['test', 'lint', 'build', 'smoke'];
const STAGES = ['step', 'submit'];
const REPORT_FORMATS = ['stdout', 'junit'];
// Defaults keep a v1 config behaving exactly as before: only tests ran
// before review, and they decided it.
const CHECK_DEFAULTS = {
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

class WorkspaceError extends Error {
  /** `field` names the settings input at fault ('root' or a command kind). */
  constructor(message, code, field) {
    super(message);
    this.name = 'WorkspaceError';
    this.code = code;
    if (field) this.field = field;
  }
}

function emptyConfig() {
  const checks = Object.fromEntries(COMMAND_KINDS.map((kind) => [kind, null]));
  return { version: CONFIG_VERSION, root: null, checks, commands: { ...checks } };
}

/** A workspace-relative report path: no absolute paths, no `..`, no odd bytes. */
function normalizeReportPath(value, kind) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new WorkspaceError(`${kind} junit report needs a path`, 'invalid_report', kind);
  }
  const clean = value.trim();
  const parts = clean.split(/[\\/]/);
  if (clean.length > 200 || path.isAbsolute(clean) || /^[A-Za-z]:/.test(clean)
    || parts.some((part) => part === '..' || part === '') || /[\0-\x1f]/.test(clean)) {
    throw new WorkspaceError(`${kind} report path must stay inside the workspace`, 'invalid_report', kind);
  }
  return parts.join('/');
}

/**
 * A check is a verification command plus when it runs and whether it can
 * reject a review on its own. Like a bare command it is user configuration
 * only; nothing here ever comes from a work package or an agent.
 */
function normalizeCheck(value, kind) {
  if (value === null || value === undefined) return null;
  const entry = normalizeCommand(value, kind);
  const defaults = CHECK_DEFAULTS[kind];
  const stage = value.stage ?? defaults.stage;
  if (!STAGES.includes(stage)) throw new WorkspaceError(`${kind} stage must be step or submit`, 'invalid_check', kind);
  const blocking = value.blocking ?? defaults.blocking;
  if (typeof blocking !== 'boolean') throw new WorkspaceError(`${kind} blocking must be true or false`, 'invalid_check', kind);

  const format = value.report?.format ?? 'stdout';
  if (!REPORT_FORMATS.includes(format)) throw new WorkspaceError(`${kind} report format is not supported`, 'invalid_report', kind);
  const report = format === 'junit' ? { format, path: normalizeReportPath(value.report.path, kind) } : { format };

  const env = {};
  if (value.env !== undefined && value.env !== null) {
    if (typeof value.env !== 'object' || Array.isArray(value.env)) throw new WorkspaceError(`${kind} env must be an object`, 'invalid_check', kind);
    const pairs = Object.entries(value.env);
    if (pairs.length > MAX_ENV) throw new WorkspaceError(`${kind} sets too many environment variables`, 'invalid_check', kind);
    for (const [name, text] of pairs) {
      // PATH and friends stay under TaskPilot's control (see shell-env.js).
      if (!ENV_NAME.test(name) || name === 'PATH' || name.startsWith('NODE_OPTIONS') || typeof text !== 'string' || text.length > 500) {
        throw new WorkspaceError(`${kind} env ${name} is not allowed`, 'invalid_check', kind);
      }
      env[name] = text;
    }
  }

  const check = { ...entry, stage, blocking, report, env };
  if (value.timeoutMs !== undefined && value.timeoutMs !== null) {
    if (!Number.isInteger(value.timeoutMs) || value.timeoutMs < MIN_TIMEOUT_MS || value.timeoutMs > MAX_TIMEOUT_MS) {
      throw new WorkspaceError(`${kind} timeout must be 1 s to 60 min`, 'invalid_check', kind);
    }
    check.timeoutMs = value.timeoutMs;
  }
  return check;
}

/**
 * A command is stored as {command, args} — an executable plus an argument
 * array, never a shell string. This keeps execution off the shell so nothing
 * in the configured values can be interpreted as an operator.
 */
function normalizeCommand(value, kind) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkspaceError(`${kind} command must be an object`, 'invalid_command', kind);
  }
  const { command, args = [] } = value;
  if (typeof command !== 'string' || !command.trim()) {
    throw new WorkspaceError(`${kind} command is missing an executable`, 'invalid_command', kind);
  }
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
    throw new WorkspaceError(`${kind} command args must be strings`, 'invalid_command', kind);
  }
  return { command: command.trim(), args: [...args] };
}

/**
 * Splits a command line typed in settings into {command, args}.
 *
 * This is a tokenizer, not a shell: quotes group words and backslashes escape,
 * but nothing is expanded, substituted, or executed. Returns null for a blank
 * line, which means "not configured".
 */
function parseCommandLine(text, kind) {
  if (text === null || text === undefined) return null;
  if (typeof text !== 'string') {
    throw new WorkspaceError(`${kind} command must be text`, 'invalid_command', kind);
  }

  const tokens = [];
  let value = '';
  let inToken = false;
  let quoted = false; // any part of the current token was quoted or escaped
  let quote = null;

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
  if (tokens.length === 0) return null;

  const operator = tokens.find((token) => !token.quoted && SHELL_OPERATORS.has(token.value));
  if (operator) {
    throw new WorkspaceError(`${kind} command uses shell syntax "${operator.value}"`, 'shell_syntax', kind);
  }
  const [command, ...args] = tokens.map((token) => token.value);
  return normalizeCommand({ command, args }, kind);
}

/** Inverse of parseCommandLine(), quoting only where needed. */
function formatCommandLine(entry) {
  if (!entry) return '';
  return [entry.command, ...entry.args]
    .map((token) => (token === '' || /[\s'"\\]/.test(token) || SHELL_OPERATORS.has(token)
      ? `'${token.replace(/'/g, "'\\''")}'`
      : token))
    .join(' ');
}

/**
 * Turns the settings form into a config. `commands` holds one typed line per
 * kind; `options` (optional) holds {stage, blocking, reportPath} per kind.
 * Settings the form does not show (env, timeout) are kept from `previous`.
 */
function fromForm(form, previous = null) {
  const checks = {};
  for (const kind of COMMAND_KINDS) {
    const entry = parseCommandLine(form?.commands?.[kind], kind);
    if (!entry) { checks[kind] = null; continue; }
    const options = form?.options?.[kind] ?? {};
    const kept = previous?.checks?.[kind];
    const reportPath = typeof options.reportPath === 'string' ? options.reportPath.trim() : null;
    checks[kind] = {
      ...entry,
      stage: options.stage ?? kept?.stage,
      blocking: options.blocking ?? kept?.blocking,
      report: reportPath === null ? kept?.report : reportPath ? { format: 'junit', path: reportPath } : { format: 'stdout' },
      env: kept?.env,
      timeoutMs: kept?.timeoutMs,
    };
  }
  return normalize({ root: form?.root, checks });
}

/** What the settings form edits, the inverse of fromForm(). */
function toForm(config) {
  const commands = {};
  const options = {};
  for (const kind of COMMAND_KINDS) {
    const check = config.checks[kind];
    commands[kind] = formatCommandLine(check);
    options[kind] = check
      ? { stage: check.stage, blocking: check.blocking, reportPath: check.report.format === 'junit' ? check.report.path : '' }
      : { ...CHECK_DEFAULTS[kind], reportPath: '' };
  }
  return { root: config.root ?? '', commands, options };
}

/**
 * Finds the file `command` would launch, the way execFile does: through PATH
 * for a bare name, relative to `cwd` for a path. Returns null when nothing
 * executable is found, so settings can warn before a run fails.
 */
async function resolveExecutable(command, {
  cwd = null,
  envPath = process.env.PATH ?? '',
  platform = process.platform,
  pathExt = process.env.PATHEXT,
} = {}) {
  const extensions = platform === 'win32' ? ['', ...(pathExt ?? '.EXE;.CMD;.BAT').split(';')] : [''];
  const isPath = command.includes('/') || (platform === 'win32' && command.includes('\\'));
  const bases = [];
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
}

/**
 * Accepts a v2 config ({checks}) or a v1 one ({commands}); v1 commands get
 * the defaults for their kind. `commands` is kept on the result as a plain
 * {command, args} view for callers that only run a command.
 */
function normalize(raw) {
  const config = emptyConfig();
  if (raw && typeof raw === 'object') {
    if (typeof raw.root === 'string' && raw.root.trim()) config.root = raw.root.trim();
    const source = raw.checks && typeof raw.checks === 'object' ? raw.checks : raw.commands;
    for (const kind of COMMAND_KINDS) {
      const check = normalizeCheck(source?.[kind], kind);
      config.checks[kind] = check;
      config.commands[kind] = check && { command: check.command, args: [...check.args] };
    }
  }
  return config;
}

/** The persisted shape: `commands` is derived, so it is not written. */
function serialize(config) {
  return { version: CONFIG_VERSION, root: config.root, checks: config.checks };
}

async function load(configDir) {
  const file = path.join(configDir, CONFIG_FILENAME);
  try {
    return normalize(JSON.parse(await fs.readFile(file, 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') return emptyConfig();
    if (error instanceof SyntaxError) {
      throw new WorkspaceError(`${CONFIG_FILENAME} is not valid JSON`, 'invalid_json');
    }
    throw error;
  }
}

async function save(configDir, raw) {
  const config = normalize(raw);
  await fs.mkdir(configDir, { recursive: true });
  const file = path.join(configDir, CONFIG_FILENAME);
  await fs.writeFile(file, `${JSON.stringify(serialize(config), null, 2)}\n`);
  return config;
}

/**
 * True when `candidate` is inside `root`. Used to keep file reads and the
 * work package file scope from escaping the workspace via `../`.
 */
function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(root, candidate));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

module.exports = {
  CONFIG_FILENAME,
  CONFIG_VERSION,
  COMMAND_KINDS,
  STAGES,
  CHECK_DEFAULTS,
  WorkspaceError,
  emptyConfig,
  normalize,
  normalizeCommand,
  normalizeCheck,
  normalizeReportPath,
  parseCommandLine,
  formatCommandLine,
  fromForm,
  toForm,
  serialize,
  resolveExecutable,
  load,
  save,
  isInside,
};
