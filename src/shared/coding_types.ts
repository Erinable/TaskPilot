// Typed coding-run contract. Coding executors never share the restricted
// analysis runner or its transition authority.
import type { CheckKind, CheckRun, ErrorInfo } from './ipc_types.ts';
import type { AgentRuntimeConfig, CliId, ThinkingLevel } from './agent_runtime.ts';

export type CodingConfig = AgentRuntimeConfig & { user: string; timeoutMinutes: number };
export type CodingRuntimeStatus = {
  backend: CliId;
  protocol: string;
  boundary: 'separate-user';
  // Set by the IPC layer: where the user finds the setup script.
  setupScript?: string;
  available: boolean;
  version: string | null;
  reason: string | null;
  config: CodingConfig;
};
// ready → (applying → verifying) → submitted, or a new round on failure.
// applied: the patch is in the working tree and the loop stopped there.
export type CodingRunStatus =
  'preparing' | 'running' | 'checking' | 'ready' | 'applying' | 'verifying' | 'applied' | 'submitted' | 'failed' | 'cancelled' | 'discarded';
// What started a round: the developer, failing submit checks, or a QA rejection.
export type CodingTrigger = 'human' | 'checks_failed' | 'qa_rejected';
// Why the automatic loop stopped and handed back to the developer.
export type CodingHalt = 'attempts_exhausted' | 'high_risk' | 'no_changes' | 'stopped';
export type CodingRound = { attempt: number; trigger: CodingTrigger; status: CodingRunStatus; costUsd: number | null; files: number };
// Automatic rounds a chain gets after the developer's, shared by failed checks and QA rejections.
export const MAX_AUTO_ATTEMPTS = 3;
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
  // 1 for the developer's round; each automatic retry adds one.
  attempt: number;
  trigger: CodingTrigger;
  // Failing checks or QA issues handed to this round, as sent to the agent.
  feedback: string | null;
  halt: CodingHalt | null;
  // Earlier rounds of the same chain, oldest first.
  rounds: CodingRound[];
};
export type CodingStart = { instruction: string; resume?: boolean };
// files: the patch paths the developer accepted; the rest are left out.
export type CodingApply = { digest: string; allowHighRisk: boolean; files: string[] };
export type CodingApplyResult = { files: string[] };
