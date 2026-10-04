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
const COMMAND_KINDS = ['test', 'lint', 'build'];

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
  return { root: null, commands: { test: null, lint: null, build: null } };
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

/** Turns the settings form ({root, commands: {kind: line}}) into a config. */
function fromForm(form) {
  const commands = {};
  for (const kind of COMMAND_KINDS) commands[kind] = parseCommandLine(form?.commands?.[kind], kind);
  return normalize({ root: form?.root, commands });
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

function normalize(raw) {
  const config = emptyConfig();
  if (raw && typeof raw === 'object') {
    if (typeof raw.root === 'string' && raw.root.trim()) config.root = raw.root.trim();
    for (const kind of COMMAND_KINDS) {
      config.commands[kind] = normalizeCommand(raw.commands?.[kind], kind);
    }
  }
  return config;
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
  await fs.writeFile(file, `${JSON.stringify(config, null, 2)}\n`);
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
  COMMAND_KINDS,
  WorkspaceError,
  emptyConfig,
  normalize,
  normalizeCommand,
  parseCommandLine,
  formatCommandLine,
  fromForm,
  resolveExecutable,
  load,
  save,
  isInside,
};
