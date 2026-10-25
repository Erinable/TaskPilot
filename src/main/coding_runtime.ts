// How Coding Agent runs are isolated, read and cleaned, shared by the coding
// loop and practice's reference runs. Sandbox runs live under
// userData/coding-runs, separate-user runs under the coder account's home; a
// run is cleaned and read in the mode it started in.
import os from 'node:os';
import path from 'node:path';

import { errorCode } from './coded_error.ts';
import * as codingExec from './coding_exec.ts';
import * as codingWorkspace from './coding_workspace.ts';
import * as codingSandbox from './coding_sandbox.ts';
import * as patchMerge from './patch_merge.ts';
import { env as appEnv } from './env.ts';
import type * as ipc from '../shared/ipc_types.ts';
import type { AppContext } from './app_context.ts';
import type { TaskDefinition } from './tasks.ts';

// The coding executor and workspace operations; injectable for tests.
export type CodingDeps = {
  // Where the user finds the coding user setup script: the bundled copy, or scripts/ in development.
  setupScript?: string;
  probe?: typeof codingExec.probeRuntime;
  prepare?: typeof codingWorkspace.prepare;
  run?: typeof codingExec.runCoding;
  readPatch?: typeof codingWorkspace.readPatch;
  // How each patched file merges with the working tree.
  previewMerge?: typeof patchMerge.previewMerge;
  applyPatch?: typeof codingWorkspace.applyPatch;
  clean?: typeof codingWorkspace.clean;
  snapshot?: typeof codingWorkspace.snapshotBaseline;
};

export const codingCancelled = (error: unknown, signal: AbortSignal) =>
  signal.aborted || errorCode(error) === 'coding_aborted' || errorCode(error) === 'workspace_aborted';

export const billableCodingUsage = (error: unknown) => {
  const spent = error instanceof codingExec.CodingExecError ? error.usage : null;
  return spent && (spent.costUsd !== null || spent.inputTokens !== null || spent.outputTokens !== null) ? spent : null;
};

export const codingFailure = (error: unknown): ipc.ErrorInfo => ({
  code: errorCode(error) ?? 'coding_failed',
  message: error instanceof Error ? error.message : String(error),
});

export const createCodingRuntime = (ctx: AppContext, deps: CodingDeps = {}) => {
  const {
    setupScript = 'scripts/setup-coding-agent-user.sh',
    probe = codingExec.probeRuntime,
    prepare = codingWorkspace.prepare,
    run = codingExec.runCoding,
    readPatch = codingWorkspace.readPatch,
    previewMerge = patchMerge.previewMerge,
    applyPatch = codingWorkspace.applyPatch,
    clean = codingWorkspace.clean,
    snapshot = codingWorkspace.snapshotBaseline,
  } = deps;
  const { getPreferences, configDir } = ctx;

  const sandboxRunRoot = path.join(configDir, codingSandbox.RUNS_DIRNAME);
  const sandboxContext = async (): Promise<codingSandbox.SandboxContext> => {
    const coding = getPreferences().coding;
    const { path: envPath } = await ctx.commandPath();
    return {
      home: os.homedir(),
      runRoot: sandboxRunRoot,
      probeFile: path.join(configDir, codingSandbox.PROBE_FILENAME),
      pathEntries: (envPath || appEnv.path).split(':').filter(Boolean),
      extraRead: coding.extraRead,
      extraWrite: coding.extraWrite,
    };
  };
  const sandboxed = () => getPreferences().coding?.isolation !== 'separate-user';
  // The isolation of a run about to start, fixed for the whole run like the CLI choice.
  const startSandbox = async () => (sandboxed() ? await sandboxContext() : undefined);
  const runNameFor = (sandbox: codingSandbox.SandboxContext | undefined, runId: string) =>
    path.join(sandbox ? sandboxRunRoot : codingWorkspace.DEFAULT_RUN_ROOT, runId);
  const sandboxOfRun = async (runName: string) => (path.dirname(runName) === sandboxRunRoot ? await sandboxContext() : undefined);
  const readRunPatch = async (runName: string, fileScope: string[], extra: { signal?: AbortSignal; cli?: ipc.CliId } = {}) =>
    readPatch(runName, fileScope, { ...extra, sandbox: await sandboxOfRun(runName) });
  const cleanRun = async (runName: string) => clean(runName, { sandbox: await sandboxOfRun(runName) });
  const probeCoding = async (config: ipc.AgentRuntimeConfig) => probe({ config, sandbox: sandboxed() ? await sandboxContext() : undefined });

  const codingStatus = async (): Promise<ipc.CodingRuntimeStatus> => {
    const status = await probeCoding({ ...getPreferences().agents['coding-agent'] });
    return { ...status, config: { ...status.config, timeoutMinutes: getPreferences().coding.timeoutMinutes }, setupScript };
  };

  // QA checks linked tests by name, so the names go in exactly as planned.
  const codingPrompt = (task: TaskDefinition, instruction: string, feedback: string | null) => {
    const interfaces = ctx.interfacesFor(task);
    return [
      'You are TaskPilot Coding Agent. Work only in the current isolated repository.',
      'Do not commit, push, change git remotes, or modify files outside the requested scope.',
      `Requested files: ${task.fileScope.join(', ') || '(none)'}`,
      `Work package: ${task.title}`,
      'Steps:',
      ...task.steps.map((step, index) => `${index + 1}. ${step}`),
      'Acceptance:',
      ...task.acceptance.map((item) => (item.test ? `- ${item.text} (proved by a test named exactly "${item.test}")` : `- ${item.text}`)),
      ...(interfaces ? ['', '<interface_summary author="Architect">', interfaces, '</interface_summary>'] : []),
      `Developer instruction: ${instruction}`,
      ...(feedback ? ['', 'The repository already contains your previous attempt.', feedback] : []),
    ].join('\n');
  };

  return {
    prepare,
    run,
    readPatch,
    previewMerge,
    applyPatch,
    snapshot,
    sandboxed,
    startSandbox,
    runNameFor,
    readRunPatch,
    cleanRun,
    probeCoding,
    codingStatus,
    codingPrompt,
  };
};

export type CodingRuntime = ReturnType<typeof createCodingRuntime>;
