// Workspace configuration: the repository TaskPilot observes and the commands
// it is allowed to run for verification.
//
// SECURITY: verification commands are the only commands TaskPilot executes, and
// they come from this file alone — never from work package data. Work packages
// are authored by AI agents; treating a command in one as executable would turn
// agent output into arbitrary code execution on the developer's machine.
const fs = require('node:fs/promises');
const path = require('node:path');

const CONFIG_FILENAME = 'workspace.json';
const COMMAND_KINDS = ['test', 'lint', 'build'];

class WorkspaceError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'WorkspaceError';
    this.code = code;
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
    throw new WorkspaceError(`${kind} command must be an object`, 'invalid_command');
  }
  const { command, args = [] } = value;
  if (typeof command !== 'string' || !command.trim()) {
    throw new WorkspaceError(`${kind} command is missing an executable`, 'invalid_command');
  }
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
    throw new WorkspaceError(`${kind} command args must be strings`, 'invalid_command');
  }
  return { command: command.trim(), args: [...args] };
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
  load,
  save,
  isInside,
};
