// Workspace configuration on this machine: the repository TaskPilot observes
// and the check steps it is allowed to run there. The repository's own
// taskpilot.toml (./project_config.ts) and its preset fill in what this file
// leaves unset (./effective_steps.ts).
//
// SECURITY: check commands are the only commands TaskPilot executes, and
// they come from this file, the repository's taskpilot.toml or a preset —
// never from work package data. Work packages are authored by AI agents;
// treating a command in one as executable would turn agent output into
// arbitrary code execution on the developer's machine.
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';

import { env } from './env.ts';
import { jsonText, writeFileAtomic } from './atomic_json_file.ts';
import { WorkspaceError } from './command_line.ts';
import { isStepId } from '../shared/check_steps.ts';
import * as stepConfig from './step_config.ts';
import type { StepId } from '../shared/check_steps.ts';
import type { StoredStep } from './step_config.ts';
import type { LooseJson } from './loose_json.ts';

export const CONFIG_FILENAME = 'workspace.json';
export const CONFIG_VERSION = 3;

// A normalized workspace.json. `steps` holds only what this machine sets;
// a step left out falls through to taskpilot.toml and the preset.
export interface WorkspaceConfig {
  version: number;
  root: string | null;
  steps: Partial<Record<StepId, StoredStep>>;
}

export const emptyConfig = (): WorkspaceConfig => ({ version: CONFIG_VERSION, root: null, steps: {} });

// v2 stored {test, lint, build, smoke} checks with a stdout or JUnit report.
// They become steps of the same name; `smoke` has no fixed step and becomes
// custom:smoke.
const V2_IDS: Record<string, StepId> = { test: 'test', lint: 'lint', build: 'build', smoke: 'custom:smoke' };
// The v2 defaults, which differ from the steps' for smoke.
const V2_DEFAULTS: Record<string, { stage: string; blocking: boolean }> = {
  test: { stage: 'submit', blocking: true },
  lint: { stage: 'step', blocking: false },
  build: { stage: 'step', blocking: false },
  smoke: { stage: 'submit', blocking: true },
};

const upgradeCheck = (kind: string, check: LooseJson) => ({
  commands: [{ command: check.command, args: check.args ?? [] }],
  stage: check.stage ?? V2_DEFAULTS[kind].stage,
  blocking: check.blocking ?? V2_DEFAULTS[kind].blocking,
  parser: check.report?.format === 'junit' ? { format: 'junit', path: check.report.path } : { format: 'tests' },
  env: check.env,
  timeoutMs: check.timeoutMs,
});

// The steps of a v1 ({commands}) or v2 ({checks}) file, in v3 form.
const upgradeSteps = (raw: LooseJson): Record<string, unknown> => {
  const source = raw.checks && typeof raw.checks === 'object' ? raw.checks : raw.commands;
  const steps: Record<string, unknown> = {};
  for (const [kind, id] of Object.entries(V2_IDS)) {
    const check = source?.[kind];
    if (check && typeof check === 'object') steps[id] = upgradeCheck(kind, check);
  }
  return steps;
};

// Accepts v3 ({steps}) or an older file, which is upgraded. Every step is
// validated; an error names its field (`steps.lint.parser.format`).
export const normalize = (input: unknown): WorkspaceConfig => {
  const config = emptyConfig();
  if (!input || typeof input !== 'object') return config;
  const raw = input as LooseJson;
  if (typeof raw.root === 'string' && raw.root.trim()) config.root = raw.root.trim();
  const steps = raw.steps && typeof raw.steps === 'object' && !Array.isArray(raw.steps) ? raw.steps : raw.version === CONFIG_VERSION ? {} : upgradeSteps(raw);
  for (const [id, value] of Object.entries(steps)) {
    if (!isStepId(id)) throw new WorkspaceError(`steps.${id}: is not a check step`, 'invalid_step', `steps.${id}`);
    if (value !== null && value !== undefined) config.steps[id] = stepConfig.normalizeStoredStep(value, id, `steps.${id}`);
  }
  return config;
};

export const serialize = (config: WorkspaceConfig) => ({ version: CONFIG_VERSION, root: config.root, steps: config.steps });

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

// True when `candidate` is inside `root`. Used to keep file reads and the
// work package file scope from escaping the workspace via `../`.
export const isInside = (root: string, candidate: string): boolean => {
  const relative = path.relative(path.resolve(root), path.resolve(root, candidate));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
};
