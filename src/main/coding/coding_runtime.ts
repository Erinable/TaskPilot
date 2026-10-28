// How Coding Agent runs are isolated, read and cleaned, shared by the coding
// loop and practice's reference runs. Sandbox runs live under
// userData/coding-runs, separate-user runs under the coder account's home; a
// run is cleaned and read in the mode it started in.
import os from 'node:os';
import path from 'node:path';

import { asAgentError, errorCode } from '../infrastructure/coded_error.ts';
import * as codingExec from './coding_exec.ts';
import { CodingExecError } from './coding_process.ts';
import * as codingWorkspace from './coding_workspace.ts';
import * as codingSandbox from './coding_sandbox.ts';
import * as patchMerge from './patch_merge.ts';
import * as presets from '../checking/presets/index.ts';
import { env as appEnv } from '../infrastructure/env.ts';
import { profileBlock } from '../agents/prompt_blocks.ts';
import type * as agentRuntimeTypes from '../../shared/agent_runtime.ts';
import type * as codingTypes from '../../shared/coding_types.ts';
import type * as envelopeTypes from '../../shared/ipc/envelope.ts';
import type { AppContext } from '../app/app_context.ts';
import type { ProfileSection } from '../agents/prompt_blocks.ts';
import type { ProjectProfile } from '../../shared/project_profile.ts';
import type { TaskDefinition } from '../work_packages/tasks.ts';

type CodingRuntimeContext = Pick<AppContext, 'commandPath' | 'configDir' | 'getPreferences' | 'interfacesFor' | 'profile'>;

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
  const spent = error instanceof CodingExecError ? error.usage : null;
  return spent && (spent.costUsd !== null || spent.inputTokens !== null || spent.outputTokens !== null) ? spent : null;
};
export const codingFailure = (error: unknown): envelopeTypes.ErrorInfo => {
  const info = asAgentError(error);
  return { code: info.code === 'unknown' ? 'coding_failed' : info.code, message: info.message };
};

// What of the project profile Coding Agent prompts show; empty until a later change
// moves a language-specific sentence into the profile (see
// tests/main/agents/prompt_golden.test.ts).
const CODING_PROFILE_SECTIONS: ProfileSection[] = [];

export const createCodingRuntime = (ctx: CodingRuntimeContext, deps: CodingDeps = {}) => {
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

  // The presets of the open repository's languages (taskpilot.toml's, or the
  // detected ones), for what only those languages need.
  const languagePresets = async () => presets.presetsOf((await ctx.profile())?.languages.map((language) => language.id) ?? []);
  const patchRules = async (): Promise<codingWorkspace.PatchRules> => {
    const list = await languagePresets();
    return { protectedFiles: list.flatMap((preset) => preset.protectedFiles), secretFiles: list.flatMap((preset) => preset.secretFiles) };
  };
  const readRulePatch: typeof readPatch = async (runName, fileScope, options = {}) => readPatch(runName, fileScope, { rules: await patchRules(), ...options });

  const sandboxRunRoot = path.join(configDir, codingSandbox.RUNS_DIRNAME);
  const sandboxContext = async (): Promise<codingSandbox.SandboxContext> => {
    const coding = getPreferences().coding;
    const { path: envPath } = await ctx.commandPath();
    const home = os.homedir();
    const languages = await languagePresets();
    return {
      home,
      runRoot: sandboxRunRoot,
      probeFile: path.join(configDir, codingSandbox.PROBE_FILENAME),
      pathEntries: (envPath || appEnv.path).split(':').filter(Boolean),
      extraRead: coding.extraRead,
      extraWrite: coding.extraWrite,
      languageEnv: (agentHome) => Object.assign({}, ...languages.map((preset) => preset.sandboxEnv(agentHome, home))),
      languageRead: languages.flatMap((preset) => preset.sandboxRead(home)),
    };
  };
  const sandboxed = () => getPreferences().coding?.isolation !== 'separate-user';
  // The isolation of a run about to start, fixed for the whole run like the CLI choice.
  const startSandbox = async () => (sandboxed() ? await sandboxContext() : undefined);
  const runNameFor = (sandbox: codingSandbox.SandboxContext | undefined, runId: string) =>
    path.join(sandbox ? sandboxRunRoot : codingWorkspace.DEFAULT_RUN_ROOT, runId);
  const sandboxOfRun = async (runName: string) => (path.dirname(runName) === sandboxRunRoot ? await sandboxContext() : undefined);
  const readRunPatch = async (runName: string, fileScope: string[], extra: { signal?: AbortSignal; cli?: agentRuntimeTypes.CliId } = {}) =>
    readRulePatch(runName, fileScope, { ...extra, sandbox: await sandboxOfRun(runName) });
  const cleanRun = async (runName: string) => clean(runName, { sandbox: await sandboxOfRun(runName) });
  const probeCoding = async (config: agentRuntimeTypes.AgentRuntimeConfig) => probe({ config, sandbox: sandboxed() ? await sandboxContext() : undefined });

  const codingStatus = async (): Promise<codingTypes.CodingRuntimeStatus> => {
    const status = await probeCoding({ ...getPreferences().agents['coding-agent'] });
    return { ...status, config: { ...status.config, timeoutMinutes: getPreferences().coding.timeoutMinutes }, setupScript };
  };

  // QA checks linked tests by name, so the names go in exactly as planned,
  // with the form the repository's test results give them.
  // The submit-stage checks are listed with their commands so the agent can
  // run them itself before handing the change back.
  const codingPrompt = (task: TaskDefinition, instruction: string, feedback: string | null, profile?: ProjectProfile | null) => {
    const interfaces = ctx.interfacesFor(task);
    const submitChecks = profile?.checks.filter((check) => check.stage === 'submit') ?? [];
    const testNameFormat = task.acceptance.some((item) => item.test) ? (profile?.testNameFormat ?? null) : null;
    return [
      'You are TaskPilot Coding Agent. Work only in the current isolated repository.',
      'Do not commit, push, change git remotes, or modify files outside the requested scope.',
      `Requested files: ${task.fileScope.join(', ') || '(none)'}`,
      `Work package: ${task.title}`,
      'Steps:',
      ...task.steps.map((step, index) => `${index + 1}. ${step}`),
      'Acceptance:',
      ...task.acceptance.map((item) => (item.test ? `- ${item.text} (proved by a test named exactly "${item.test}")` : `- ${item.text}`)),
      // [人工决策-2026-10-25 23:51:35] 测试名精确匹配，只在 prompt 里注入名字格式（CARM-16 决策 A）。
      ...(testNameFormat
        ? [
            `TaskPilot matches these names exactly against the test results, where a test's name is ${testNameFormat}. Write each test so it is reported under exactly that name.`,
          ]
        : []),
      ...(interfaces ? ['', '<interface_summary author="Architect">', interfaces, '</interface_summary>'] : []),
      ...(submitChecks.length
        ? [
            'Before review, TaskPilot runs these checks on your change; run them yourself first and fix what fails:',
            ...submitChecks.map((check) => `- ${check.label} (${check.blocking ? 'blocking' : 'advisory'}): ${check.commandLine}`),
          ]
        : []),
      `Developer instruction: ${instruction}`,
      ...(feedback ? ['', 'The repository already contains your previous attempt.', feedback] : []),
      ...profileBlock(profile, CODING_PROFILE_SECTIONS),
    ].join('\n');
  };

  return {
    prepare,
    run,
    readPatch: readRulePatch,
    patchRules,
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
