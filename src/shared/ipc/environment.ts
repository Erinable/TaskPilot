// Environment Steward's setup session (env:*).

import type { IpcFailure } from './envelope.ts';
import type { RunSummary } from './workspace.ts';
import type { StepKind } from '../check_steps.ts';
import { invoke } from './contract.ts';
import type { Contract } from './contract.ts';

// A step kind the plan names a script for; which ones depends on the
// repository's setup adapter.
export type ScriptKind = StepKind;
// setup_unsupported: no setup adapter for the repository's languages yet.
export type EnvBlocker = 'setup_unsupported' | 'no_manifest' | 'invalid_manifest' | 'unsupported_manager' | 'node_missing' | 'npm_missing';

export type EnvManifest = {
  valid: boolean;
  name: string | null;
  scripts: Record<string, string>;
  engines: Record<string, string>;
  packageManager: string | null;
};

// The npm adapter's facts (presets/typescript_setup.ts), with workflow files
// reduced to their paths; the only adapter there is so far.
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
  // One of the adapter's install modes, such as 'ci', 'install' or 'skip'.
  install: string;
  installReason: string;
  scripts: Partial<Record<ScriptKind, string | null>>;
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
  // The kinds the plan can name a script for; empty without an adapter.
  stepKinds: ScriptKind[];
  // This machine's current command line per kind ('' when not set here).
  configured: Partial<Record<ScriptKind, string>>;
};

// Re-planning after a failed step hands the steward that step's output.
export type EnvPlanOptions = { withFailure?: boolean };

// env:apply writes the scripts into workspace.json and returns the session.
export type EnvApplyResult = EnvState;

export const envContract = {
  get: invoke<[], EnvState>('env:get'),
  plan: invoke<[options?: EnvPlanOptions], EnvState>('env:plan'),
  setAllowScripts: invoke<[allow: boolean], EnvState>('env:set-allow-scripts'),
  runStep: invoke<[stepId: string], EnvState>('env:run-step'),
  apply: invoke<[kinds: ScriptKind[]], EnvApplyResult>('env:apply'),
  cancel: invoke<[], boolean>('env:cancel'),
} satisfies Contract;
