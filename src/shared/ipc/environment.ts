// Environment Steward's setup session (env:*).

import type { IpcFailure } from './envelope.ts';
import type { RunSummary } from './workspace.ts';

export type InstallMode = 'ci' | 'install' | 'skip';
export type ScriptKind = 'test' | 'lint' | 'build';
export type EnvBlocker = 'no_manifest' | 'invalid_manifest' | 'unsupported_manager' | 'node_missing' | 'npm_missing';

export type EnvManifest = {
  valid: boolean;
  name: string | null;
  scripts: Record<string, string>;
  engines: Record<string, string>;
  packageManager: string | null;
};

// presets/typescript_setup.probe() facts, with workflow files reduced to their paths.
export type EnvFacts = {
  manifest: EnvManifest | null;
  lockfiles: string[];
  managers: string[];
  nodeModules: boolean;
  versionFiles: { path: string; content: string }[];
  workflows: string[];
  tools: { node: string | null; npm: string | null };
  // Dependencies that only work after their install scripts run.
  installScripts: string[];
};

// Corrections TaskPilot made to the steward's plan.
export type EnvAdjustment = { code: 'install_without_manifest' | 'ci_without_lockfile' } | { code: 'unknown_script'; kind: ScriptKind; script: string };

export type EnvPlan = {
  summary: string;
  install: InstallMode;
  installReason: string;
  scripts: Record<ScriptKind, string | null>;
  // Suggested fixes are shown, never run.
  issues: { text: string; fix: string }[];
  adjustments: EnvAdjustment[];
};

export type EnvStepResult = {
  line: string;
  ok: boolean;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  // Null for the install step.
  summary: RunSummary | null;
  output: string;
  at: string;
};

export type EnvStepId = 'install' | 'rebuild' | ScriptKind;

export type EnvStep = {
  id: EnvStepId;
  kind: EnvStepId;
  script: string | null;
  // For the rebuild step: the packages whose install scripts it runs.
  packages: string[];
  // The step deletes node_modules before installing (npm ci over an
  // existing install), so it asks before running.
  replacesInstall: boolean;
  line: string;
  result: EnvStepResult | null;
};

export type EnvStatus = 'idle' | 'planning' | 'ready' | 'failed';

export type EnvState = {
  root: string | null;
  status: EnvStatus;
  // The plan was made for a different workspace root.
  stale: boolean;
  facts: EnvFacts | null;
  blockers: EnvBlocker[];
  plan: EnvPlan | null;
  error: IpcFailure | null;
  costUsd: number;
  allowScripts: boolean;
  // Id of the step running now.
  running: EnvStepId | null;
  // The running step's latest output and its start time; null when idle.
  live: { output: string; startedAt: string } | null;
  steps: EnvStep[];
  // This machine's current command line per kind ('' when not set here).
  configured: Record<ScriptKind, string>;
};

// Re-planning after a failed step hands the steward that step's output.
export type EnvPlanOptions = { withFailure?: boolean };

// env:apply writes the scripts into workspace.json and returns the session.
export type EnvApplyResult = EnvState;
