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
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';

import { processEnv } from './env.ts';
import { readTracked, indexEntries } from './repo_reader.ts';
import type { CommandEntry } from './workspace.ts';
import type { LooseJson } from './loose_json.ts';

export const LOCKFILES: Record<string, string> = {
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
export const INSTALL_MODES = ['ci', 'install', 'skip'] as const;
export const SCRIPT_KINDS = ['test', 'lint', 'build'] as const;

export type InstallMode = (typeof INSTALL_MODES)[number];
export type ScriptKind = (typeof SCRIPT_KINDS)[number];

// The parts of package.json setup reads.
export interface Manifest {
  valid: boolean;
  name: string | null;
  scripts: Record<string, string>;
  engines: Record<string, string>;
  packageManager: string | null;
}

export interface FactFile {
  path: string;
  content: string;
}

// What probe() learns about a workspace's toolchain.
export interface EnvFacts {
  manifest: Manifest | null;
  lockfiles: string[];
  managers: string[];
  nodeModules: boolean;
  versionFiles: FactFile[];
  workflows: FactFile[];
  tools: { node: string | null; npm: string | null };
}

export type Blocker = 'no_manifest' | 'invalid_manifest' | 'unsupported_manager' | 'node_missing' | 'npm_missing';

// The validated part of the Environment Steward's plan buildSteps() reads.
export interface SetupPlan {
  install: InstallMode;
  scripts: Partial<Record<ScriptKind, string | null>>;
}

// One runnable setup step.
export type SetupStep = CommandEntry & ({ id: 'install'; kind: 'install' } | { id: ScriptKind; kind: ScriptKind; script: string });

// Reads a tool's version; injectable for tests.
export type ToolVersion = (command: string, args: string[], envPath?: string | null) => Promise<string | null>;

export type EnvSetupErrorCode = 'invalid_script' | 'invalid_mode';
// npm's own script-name rules are loose; this is what TaskPilot will pass on.
export const SCRIPT_NAME = /^[A-Za-z0-9][\w:.-]{0,63}$/;

export class EnvSetupError extends Error {
  code: EnvSetupErrorCode;

  constructor(message: string, code: EnvSetupErrorCode) {
    super(message);
    this.name = 'EnvSetupError';
    this.code = code;
  }
}

const toolVersion: ToolVersion = (command, args, envPath) =>
  new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        timeout: 5000,
        env: { ...processEnv(), ...(envPath ? { PATH: envPath } : {}), NO_UPDATE_NOTIFIER: '1' },
      },
      (error, stdout) => resolve(error ? null : stdout.trim().split('\n')[0] || null),
    );
  });

export const parseManifest = (content: string): Manifest => {
  let raw: LooseJson | null;
  try {
    raw = JSON.parse(content);
  } catch {
    return { valid: false, name: null, scripts: {}, engines: {}, packageManager: null };
  }
  const scripts: Record<string, string> = {};
  for (const [name, body] of Object.entries(raw?.scripts ?? {})) {
    if (SCRIPT_NAME.test(name) && typeof body === 'string') scripts[name] = body.slice(0, 300);
  }
  const engines: Record<string, string> = {};
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
};

// Collects setup facts without running anything from the repository: tracked
// manifests and CI workflows (through repo_reader), whether node_modules
// exists, and the node/npm versions on the command PATH.
export const probe = async (root: string, { envPath, version = toolVersion }: { envPath?: string | null; version?: ToolVersion } = {}): Promise<EnvFacts> => {
  const tracked = [...(await indexEntries(root)).keys()];
  const workflows = tracked
    .filter((file) => WORKFLOW.test(file))
    .sort()
    .slice(0, MAX_WORKFLOWS);
  const wanted = ['package.json', ...VERSION_FILES, ...workflows];
  const { files } = await readTracked(root, wanted, { maxFiles: wanted.length, maxFileBytes: 64 * 1024, maxTotalBytes: 256 * 1024 });
  const content = new Map(files.map((file) => [file.path, file.content]));
  // Only called for paths content has.
  const read = (file: string) => content.get(file) as string;

  const lockfiles = tracked.filter((file) => Object.hasOwn(LOCKFILES, file));
  const managers = [...new Set(lockfiles.map((file) => LOCKFILES[file]))];
  let nodeModules = false;
  try {
    nodeModules = (await fs.stat(path.join(root, 'node_modules'))).isDirectory();
  } catch {
    // Not installed yet.
  }

  return {
    manifest: content.has('package.json') ? parseManifest(read('package.json')) : null,
    lockfiles,
    managers,
    nodeModules,
    versionFiles: VERSION_FILES.filter((file) => content.has(file)).map((file) => ({ path: file, content: read(file).trim().slice(0, 200) })),
    workflows: workflows.filter((file) => content.has(file)).map((file) => ({ path: file, content: read(file).slice(0, MAX_WORKFLOW_CHARS) })),
    tools: {
      node: await version('node', ['--version'], envPath),
      npm: await version('npm', ['--version'], envPath),
    },
  };
};

// Problems that need no model to spot; they also stop a plan from running.
export const blockers = (facts: EnvFacts): Blocker[] => {
  const found: Blocker[] = [];
  if (!facts.manifest) found.push('no_manifest');
  else if (!facts.manifest.valid) found.push('invalid_manifest');
  if (facts.managers.some((manager) => manager !== 'npm')) found.push('unsupported_manager');
  if (!facts.tools.node) found.push('node_missing');
  if (!facts.tools.npm) found.push('npm_missing');
  return found;
};

export const scriptCommand = (name: string): CommandEntry => {
  if (!SCRIPT_NAME.test(name)) throw new EnvSetupError(`Invalid script name: ${name}`, 'invalid_script');
  return name === 'test' ? { command: 'npm', args: ['test'] } : { command: 'npm', args: ['run', name] };
};

export const installCommand = (mode: string, { allowScripts = false } = {}): CommandEntry => {
  if (mode !== 'ci' && mode !== 'install') throw new EnvSetupError(`Invalid install mode: ${mode}`, 'invalid_mode');
  return {
    command: 'npm',
    args: [mode, ...(allowScripts ? [] : ['--ignore-scripts']), '--no-audit', '--no-fund'],
  };
};

// Turns a validated plan into runnable steps. Script names must exist in the
// probed package.json, so a plan can only name commands the repository
// already defines.
export const buildSteps = (plan: SetupPlan, facts: Pick<EnvFacts, 'manifest'>, { allowScripts = false } = {}): SetupStep[] => {
  const scripts = facts.manifest?.scripts ?? {};
  const steps: SetupStep[] = [];
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
};
