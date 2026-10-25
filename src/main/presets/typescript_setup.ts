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

import { processEnv } from '../env.ts';
import { readTracked, indexEntries } from '../repo_reader.ts';
import type { CommandEntry } from '../command_line.ts';
import type { LooseJson } from '../loose_json.ts';

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
  // Packages the npm lockfile marks hasInstallScript, minus optional ones
  // (platform-only builds such as fsevents). With --ignore-scripts they are
  // installed but unusable.
  installScripts: string[];
}

export type Blocker = 'no_manifest' | 'invalid_manifest' | 'unsupported_manager' | 'node_missing' | 'npm_missing';

// The validated part of the Environment Steward's plan buildSteps() reads.
export interface SetupPlan {
  install: InstallMode;
  scripts: Partial<Record<ScriptKind, string | null>>;
}

// One runnable setup step. `rebuild` runs the install scripts of only the
// packages that need them, after an install that skipped scripts.
export type SetupStep = CommandEntry &
  ({ id: 'install'; kind: 'install' } | { id: 'rebuild'; kind: 'rebuild'; packages: string[] } | { id: ScriptKind; kind: ScriptKind; script: string });

// Reads a tool's version; injectable for tests.
export type ToolVersion = (command: string, args: string[], envPath?: string | null) => Promise<string | null>;

export type EnvSetupErrorCode = 'invalid_script' | 'invalid_mode' | 'invalid_package';
// npm's own script-name rules are loose; this is what TaskPilot will pass on.
export const SCRIPT_NAME = /^[A-Za-z0-9][\w:.-]{0,63}$/;
// npm package names, optionally scoped: lowercase, no leading dot, dash or
// underscore. Nothing that could read as a flag or a path reaches npm.
export const PACKAGE_NAME = /^(@[a-z0-9][a-z0-9._~-]{0,213}\/)?[a-z0-9][a-z0-9._~-]{0,213}$/;
// Lockfiles are large; this one is read on its own budget.
const MAX_LOCKFILE_BYTES = 8 * 1024 * 1024;
const MAX_INSTALL_SCRIPTS = 50;

export class EnvSetupError extends Error {
  code: EnvSetupErrorCode;

  constructor(message: string, code: EnvSetupErrorCode) {
    super(message);
    this.name = 'EnvSetupError';
    this.code = code;
  }
}

// The first line a tool prints for its version flag; null when it is missing.
export const toolVersion: ToolVersion = (command, args, envPath) =>
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

// Top-level packages an npm v2/v3 lockfile marks hasInstallScript. Nested
// copies are rebuilt with their top-level name; optional packages are skipped.
export const parseInstallScripts = (content: string): string[] => {
  let packages: Record<string, LooseJson>;
  try {
    packages = JSON.parse(content)?.packages ?? {};
  } catch {
    return [];
  }
  if (!packages || typeof packages !== 'object') return [];
  const names = new Set<string>();
  for (const [key, entry] of Object.entries(packages)) {
    if (!entry || typeof entry !== 'object' || entry.hasInstallScript !== true || entry.optional === true) continue;
    const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    if (key.includes('node_modules/') && PACKAGE_NAME.test(name)) names.add(name);
  }
  return [...names].sort().slice(0, MAX_INSTALL_SCRIPTS);
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
  const npmLockfile = ['package-lock.json', 'npm-shrinkwrap.json'].find((file) => lockfiles.includes(file));
  const lock = npmLockfile
    ? (await readTracked(root, [npmLockfile], { maxFiles: 1, maxFileBytes: MAX_LOCKFILE_BYTES, maxTotalBytes: MAX_LOCKFILE_BYTES })).files[0]
    : undefined;
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
    installScripts: lock ? parseInstallScripts(lock.content) : [],
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

// `npm rebuild <names>` runs only those packages' install scripts.
export const rebuildCommand = (packages: string[]): CommandEntry => {
  if (!packages.length || packages.some((name) => !PACKAGE_NAME.test(name))) throw new EnvSetupError('Invalid package name', 'invalid_package');
  return { command: 'npm', args: ['rebuild', ...packages] };
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
// The rebuild step names only packages the lockfile marks, and exists only
// when install skips scripts.
// [人工决策-2026-10-15 16:05:04] 默认仍带 --ignore-scripts；锁文件标了 hasInstallScript 的非可选包，由用户点击「运行必需的安装脚本」单独 npm rebuild，其余依赖的脚本不跑（默认拒绝、按包放行）。npm ci 覆盖已有 node_modules 时先确认。
export const buildSteps = (plan: SetupPlan, facts: Pick<EnvFacts, 'manifest' | 'installScripts'>, { allowScripts = false } = {}): SetupStep[] => {
  const scripts = facts.manifest?.scripts ?? {};
  const steps: SetupStep[] = [];
  if (plan.install !== 'skip') {
    steps.push({ id: 'install', kind: 'install', ...installCommand(plan.install, { allowScripts }) });
    const packages = facts.installScripts ?? [];
    if (!allowScripts && packages.length) steps.push({ id: 'rebuild', kind: 'rebuild', packages, ...rebuildCommand(packages) });
  }
  for (const kind of SCRIPT_KINDS) {
    const name = plan.scripts[kind];
    if (!name) continue;
    if (!Object.hasOwn(scripts, name)) throw new EnvSetupError(`Script not in package.json: ${name}`, 'invalid_script');
    steps.push({ id: kind, kind, script: name, ...scriptCommand(name) });
  }
  return steps;
};
