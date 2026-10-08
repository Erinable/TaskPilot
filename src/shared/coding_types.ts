// Typed coding-run contract. Coding executors never share the restricted
// analysis runner or its transition authority.
import type { CheckKind, CheckRun, ErrorInfo } from './ipc_types.ts';
import type { AgentRuntimeConfig, CliId, ThinkingLevel } from './agent_runtime.ts';

export type CodingConfig = AgentRuntimeConfig & { user: string; timeoutMinutes: number };
export type CodingRuntimeStatus = {
  backend: CliId;
  protocol: string;
  boundary: 'separate-user';
  available: boolean;
  version: string | null;
  reason: string | null;
  config: CodingConfig;
};
export type CodingRunStatus = 'preparing' | 'running' | 'checking' | 'ready' | 'applying' | 'applied' | 'failed' | 'cancelled' | 'discarded';
export type CodingUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  reasoningTokens: number | null;
  costUsd: number | null;
};
export type CodingEvent = {
  sequence: number;
  at: string;
  type: 'status' | 'text' | 'thinking' | 'tool' | 'error';
  text: string;
};
export type CodingEventPage = { events: CodingEvent[]; next: number; truncated: boolean };
export type CodingPatchFile = { path: string; added: number; removed: number; binary: boolean; highRisk: boolean };
export type CodingPatchPreview = {
  digest: string;
  files: CodingPatchFile[];
  patch: string;
  blocked: { path: string; reason: string }[];
};
export type CodingRun = {
  id: string;
  packageId: string;
  runName: string;
  baseline: string;
  status: CodingRunStatus;
  user: string;
  model: string;
  cli: CliId;
  thinking: ThinkingLevel;
  runtimeVersion: string | null;
  sessionId: string | null;
  instruction: string;
  startedAt: string;
  finishedAt: string | null;
  error: ErrorInfo | null;
  output: string;
  usage: CodingUsage;
  files: CodingPatchFile[];
  blocked: { path: string; reason: string }[];
  checks: Partial<Record<CheckKind, CheckRun>>;
  patchDigest: string | null;
};
export type CodingStart = { instruction: string; resume?: boolean };
export type CodingApply = { digest: string; allowHighRisk: boolean };
export type CodingApplyResult = { files: string[] };
