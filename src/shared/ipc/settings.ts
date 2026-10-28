// Preferences, the PATH environment, data info and the agents' CLI status (preferences:*,
// environment:info, data:*, agent:status).

import type { AvatarColor as SharedAvatarColor } from '../avatar.ts';
import type { AgentSettings, CliId } from '../agent_runtime.ts';
import type { ErrorInfo } from './envelope.ts';
import { invoke } from './contract.ts';
import type { Contract } from './contract.ts';
import type * as agentRuntimeTypes from '../agent_runtime.ts';

export type Theme = 'system' | 'light' | 'dark';
export type AvatarColor = SharedAvatarColor;
export type PathSource = 'inherit' | 'login-shell';

// What preferences:set accepts.
export type PreferencesInput = {
  profile: { displayName: string; avatarColor: AvatarColor };
  appearance: { theme: Theme; vibrancy: boolean };
  environment: { pathSource: PathSource };
  agents: AgentSettings;
  // How the Coding Agent is isolated (the folders only apply to sandbox mode),
  // and how long one coding round may run.
  coding: { isolation: 'sandbox' | 'separate-user'; extraRead: string[]; extraWrite: string[]; timeoutMinutes: 15 | 30 | 60 | 120 };
};

// Preferences as the renderer sees them, with derived display values.
export type Preferences = PreferencesInput & { profile: { initials: string } };

// `source` previews a choice before saving; `refresh` re-reads the login shell.
export type EnvironmentInfoOptions = { source?: PathSource; refresh?: boolean };

export type EnvironmentInfo = {
  requested: PathSource;
  // What was used: login-shell falls back to inherit on error.
  source: PathSource;
  error: ErrorInfo | null;
  shell: string | null;
  entries: string[];
  inheritedCount: number;
  platform: string;
  versions: { app: string | null; electron: string | null; node: string };
};

export type PackageSummary = { total: number; claimed: number; deviations: number };

export type DataInfo = { configDir: string; files: string[]; packages: PackageSummary };
// Whether a CLI has credentials, checked offline. `unknown`: the CLI has no
// offline check and no credential file was found; it may still work.
export type CliSignIn = { state: 'signed_in' | 'signed_out' | 'unknown'; source: string | null };

// The analysis CLI (Product Lead and Architect) and the coding CLI: installed
// and usable, and signed in. Sign-in is null when the CLI is not installed.
export type AgentStatus = {
  available: boolean;
  command: string | null;
  signIn: CliSignIn | null;
  coding: { cli: CliId; installed: boolean; signIn: CliSignIn | null };
};

export const preferencesContract = {
  get: invoke<[], Preferences>('preferences:get'),
  set: invoke<[prefs: PreferencesInput], Preferences>('preferences:set'),
} satisfies Contract;

export const environmentContract = {
  info: invoke<[options?: EnvironmentInfoOptions], EnvironmentInfo>('environment:info'),
} satisfies Contract;

export const dataContract = {
  info: invoke<[], DataInfo>('data:info'),
  resetProgress: invoke<[], PackageSummary>('data:reset-progress'),
  reveal: invoke<[], true>('data:reveal'),
} satisfies Contract;

export const agentContract = {
  status: invoke<[], AgentStatus>('agent:status'),
  runtimes: invoke<[], agentRuntimeTypes.AgentRuntimeStatus[]>('agent:runtimes'),
  models: invoke<[request: agentRuntimeTypes.CliModelsRequest], agentRuntimeTypes.CliModelCatalog>('agent:models'),
} satisfies Contract;
