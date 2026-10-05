// Environment setup: what TaskPilot learns about a workspace's toolchain, and
// the only setup commands the Environment Steward's plan can turn into.
//
// SECURITY: the agent never writes a command. Its plan picks from fixed
// choices (an install mode, package.json script names) and buildSteps() turns
// those into argument arrays here, checked against the probed manifest. Every
// step still runs only when the user clicks it, through verification.run()
// (execFile, no shell). Dependency lifecycle scripts are off by default
// (--ignore-scripts) because they run third-party package code on this
// machine; the user has to opt in per run.
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { readTracked, indexEntries } = require('./repo-reader');

const LOCKFILES = {
  'package-lock.json': 'npm',
  'npm-shrinkwrap.json': 'npm',
  'yarn.lock': 'yarn',
  'pnpm-lock.yaml': 'pnpm',
  'bun.lockb': 'bun',
  'bun.lock': 'bun',
};
const VERSION_FILES = ['.nvmrc', '.node-version', '.tool-versions'];
const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/;
const MAX_WORKFLOWS = 3;
const MAX_WORKFLOW_CHARS = 4000;
const INSTALL_MODES = ['ci', 'install', 'skip'];
const SCRIPT_KINDS = ['test', 'lint', 'build'];
// npm's own script-name rules are loose; this is what TaskPilot will pass on.
const SCRIPT_NAME = /^[A-Za-z0-9][\w:.-]{0,63}$/;

class EnvSetupError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'EnvSetupError';
    this.code = code;
  }
}

function toolVersion(command, args, envPath) {
  return new Promise((resolve) => {
    execFile(command, args, {
      timeout: 5000,
      env: { ...process.env, ...(envPath ? { PATH: envPath } : {}), NO_UPDATE_NOTIFIER: '1' },
    }, (error, stdout) => resolve(error ? null : stdout.trim().split('\n')[0] || null));
  });
}

function parseManifest(content) {
  let raw;
  try {
    raw = JSON.parse(content);
  } catch {
    return { valid: false, name: null, scripts: {}, engines: {}, packageManager: null };
  }
  const scripts = {};
  for (const [name, body] of Object.entries(raw?.scripts ?? {})) {
    if (SCRIPT_NAME.test(name) && typeof body === 'string') scripts[name] = body.slice(0, 300);
  }
  const engines = {};
  for (const [name, range] of Object.entries(raw?.engines ?? {})) {
    if (typeof range === 'string') engines[name] = range.slice(0, 60);
  }
  return {
    valid: true,
    name: typeof raw?.name === 'string' ? raw.name.slice(0, 120) : null,
    scripts,
    engines,
    packageManager: typeof raw?.packageManager === 'string' ? raw.packageManager.slice(0, 60) : null,
  };
}

/**
 * Collects setup facts without running anything from the repository: tracked
 * manifests and CI workflows (through repo-reader), whether node_modules
 * exists, and the node/npm versions on the command PATH.
 */
async function probe(root, { envPath, version = toolVersion } = {}) {
  const tracked = [...(await indexEntries(root)).keys()];
  const workflows = tracked.filter((file) => WORKFLOW.test(file)).sort().slice(0, MAX_WORKFLOWS);
  const wanted = ['package.json', ...VERSION_FILES, ...workflows];
  const { files } = await readTracked(root, wanted, { maxFiles: wanted.length, maxFileBytes: 64 * 1024, maxTotalBytes: 256 * 1024 });
  const content = new Map(files.map((file) => [file.path, file.content]));

  const lockfiles = tracked.filter((file) => Object.hasOwn(LOCKFILES, file));
  const managers = [...new Set(lockfiles.map((file) => LOCKFILES[file]))];
  let nodeModules = false;
  try {
    nodeModules = (await fs.stat(path.join(root, 'node_modules'))).isDirectory();
  } catch {
    // Not installed yet.
  }

  return {
    manifest: content.has('package.json') ? parseManifest(content.get('package.json')) : null,
    lockfiles,
    managers,
    nodeModules,
    versionFiles: VERSION_FILES.filter((file) => content.has(file))
      .map((file) => ({ path: file, content: content.get(file).trim().slice(0, 200) })),
    workflows: workflows.filter((file) => content.has(file))
      .map((file) => ({ path: file, content: content.get(file).slice(0, MAX_WORKFLOW_CHARS) })),
    tools: {
      node: await version('node', ['--version'], envPath),
      npm: await version('npm', ['--version'], envPath),
    },
  };
}

/** Problems that need no model to spot; they also stop a plan from running. */
function blockers(facts) {
  const found = [];
  if (!facts.manifest) found.push('no_manifest');
  else if (!facts.manifest.valid) found.push('invalid_manifest');
  if (facts.managers.some((manager) => manager !== 'npm')) found.push('unsupported_manager');
  if (!facts.tools.node) found.push('node_missing');
  if (!facts.tools.npm) found.push('npm_missing');
  return found;
}

function scriptCommand(name) {
  if (!SCRIPT_NAME.test(name)) throw new EnvSetupError(`Invalid script name: ${name}`, 'invalid_script');
  return name === 'test' ? { command: 'npm', args: ['test'] } : { command: 'npm', args: ['run', name] };
}

function installCommand(mode, { allowScripts = false } = {}) {
  if (mode !== 'ci' && mode !== 'install') throw new EnvSetupError(`Invalid install mode: ${mode}`, 'invalid_mode');
  return {
    command: 'npm',
    args: [mode, ...(allowScripts ? [] : ['--ignore-scripts']), '--no-audit', '--no-fund'],
  };
}

/**
 * Turns a validated plan into runnable steps. Script names must exist in the
 * probed package.json, so a plan can only name commands the repository
 * already defines.
 */
function buildSteps(plan, facts, { allowScripts = false } = {}) {
  const scripts = facts.manifest?.scripts ?? {};
  const steps = [];
  if (plan.install !== 'skip') {
    steps.push({ id: 'install', kind: 'install', ...installCommand(plan.install, { allowScripts }) });
  }
  for (const kind of SCRIPT_KINDS) {
    const name = plan.scripts[kind];
    if (!name) continue;
    if (!Object.hasOwn(scripts, name)) throw new EnvSetupError(`Script not in package.json: ${name}`, 'invalid_script');
    steps.push({ id: kind, kind, script: name, ...scriptCommand(name) });
  }
  return steps;
}

module.exports = {
  LOCKFILES,
  INSTALL_MODES,
  SCRIPT_KINDS,
  SCRIPT_NAME,
  EnvSetupError,
  parseManifest,
  probe,
  blockers,
  scriptCommand,
  installCommand,
  buildSteps,
};
