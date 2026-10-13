// The renderer's only route to the filesystem, git and command execution.
// Every handler validates its arguments here: the renderer is treated as
// untrusted input, since the content it displays originates from AI agents.
import fs from 'node:fs/promises';
import path from 'node:path';
import * as tasks from './tasks.ts';
import * as git from './git.ts';
import * as workspace from './workspace.ts';
import * as verification from './verification.ts';
import * as preferences from './preferences.ts';
import { createPathResolver } from './shell_env.ts';
import type * as claudeCli from './agents/claude_cli.ts';
import * as cliRunner from './agents/cli_runner.ts';
import type { CliProbeResult } from './agents/cli_runner.ts';
import { AGENT_IDS, CLI_IDS, supportsAgentConfig } from '../shared/agent_runtime.ts';
import type { AgentId } from '../shared/agent_runtime.ts';
import { readModelCatalog } from './agent_model_catalog.ts';
import * as productLead from './agents/product_lead.ts';
import * as envSetup from './env_setup.ts';
import * as evidence from './evidence.ts';
import * as gitCommit from './git_commit.ts';
import * as tutorAgent from './agents/tutor.ts';
import * as codingExec from './coding_exec.ts';
import * as codingWorkspace from './coding_workspace.ts';
import * as codingLoop from './coding_loop.ts';
import type { CodingEventPage, CodingRun } from '../shared/coding_types.ts';
import {
  summarizeForRequirement,
  reviewWorkPackage,
  adjudicateDeviation,
  planEnvironment,
  planRelease,
  throwIfCancelled,
  RELEASE_MAX_COMMITS,
} from './agents/pipeline.ts';
import { humanTransitions } from './work_package_store.ts';
import { REGISTRY_FILENAME, REPO_FILES } from './repositories.ts';
import { TRANSITIONS, label } from './work_package_status.ts';
import type { TransitionName } from './work_package_status.ts';
import { env as appEnv } from './env.ts';
import { CHANNELS } from '../shared/ipc_channels.ts';
import { businessDay, computeAgentCosts, computeMetrics, recentByAgent, RETENTION_DAYS } from './activity_log.ts';
import type { ActivityLog, LoggedEvent } from './activity_log.ts';
import { buildEngineeringMap, MAX_TREE_FILES } from './engineering_map.ts';
import { openWorkspaceFile } from './open_file.ts';
import { indexEntries, looksSecret, readTracked } from './repo_reader.ts';
import type { Channel } from '../shared/ipc_channels.ts';
import type * as ipc from '../shared/ipc_types.ts';
import type { BaselineChecks, BaselineChecksStatus, DeviationInput, WorkPackageStore } from './work_package_store.ts';
import type { Requirement, RequirementStore } from './requirement_store.ts';
import type { EnvFailure } from './agents/env_steward.ts';
import type { ReleaseStore } from './release_store.ts';
import type { TutorStore } from './tutor_store.ts';
import type { RepositoryEntry, RepositoryRegistry } from './repositories.ts';
import type { ReleasePackage } from './agents/pipeline.ts';
import type { TaskDefinition } from './tasks.ts';

// An Error carrying the machine-readable fields IPC failures send.
type CodedError = Error & { code?: unknown; field?: unknown };

const codedError = (message: string, code: string, field?: string): CodedError => {
  const error: CodedError = new Error(message);
  error.code = code;
  if (field) error.field = field;
  return error;
};

// Shaped like an Error but safe to send over IPC.
const toFailure = (error: unknown): { ok: false; error: ipc.IpcFailure } => {
  const coded = error as CodedError;
  const failure: ipc.IpcFailure = { code: typeof coded.code === 'string' ? coded.code : 'unknown', message: coded.message };
  if (typeof coded.field === 'string' && coded.field) failure.field = coded.field;
  return { ok: false, error: failure };
};

// Caught errors are Errors; the stores record their code and message.
const asAgentError = (error: unknown) => error as { code?: string; message: string };

const errorCode = (error: unknown): string | undefined => {
  const code = (error as CodedError).code;
  return typeof code === 'string' ? code : undefined;
};

// Config plus the command lines and check options the settings form edits.
export const toFormView = (config: workspace.WorkspaceConfig): ipc.WorkspaceView => {
  const form = workspace.toForm(config);
  return { root: config.root, commands: config.commands, checks: config.checks, lines: form.commands, options: form.options };
};

// A submit-stage check, with the line its baseline is keyed by.
type SubmitCheck = { kind: workspace.CheckKind; stage: workspace.CheckStage; blocking: boolean; line: string };

// The command line plus whatever else changes what a check measures.
const checkLine = (check: workspace.Check) => {
  const extras: string[] = [];
  if (check.report.format === 'junit') extras.push(`[junit ${check.report.path}]`);
  const env = Object.entries(check.env ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .sort();
  if (env.length) extras.push(`[env ${env.join(' ')}]`);
  return [workspace.formatCommandLine(check), ...extras].join(' ');
};

// Checks that run before review, with the line their baselines are keyed by.
const submitChecks = (config: workspace.WorkspaceConfig): SubmitCheck[] =>
  workspace.COMMAND_KINDS.flatMap((kind) => {
    const check = config.checks?.[kind];
    return check?.stage === 'submit' ? [{ kind, stage: check.stage, blocking: check.blocking, line: checkLine(check) }] : [];
  });

// Report files the checks write are not the package's changes.
const reportIgnore = (config: workspace.WorkspaceConfig) => {
  const paths = new Set(
    workspace.COMMAND_KINDS.map((kind) => config.checks?.[kind]?.report).flatMap((report) => (report?.format === 'junit' ? [report.path] : [])),
  );
  return (candidate: string) => paths.has(candidate) || candidate.startsWith('.taskpilot/');
};

const requireString = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw codedError(`${name} must be a non-empty string`, 'invalid_argument');
  return value;
};

const isCommandKind = (value: unknown): value is workspace.CheckKind => workspace.COMMAND_KINDS.includes(value as workspace.CheckKind);

const isPathSource = (value: unknown): value is ipc.PathSource => preferences.PATH_SOURCES.includes(value as ipc.PathSource);

// Renderer arguments are untrusted, so handlers receive them as unknown.
type Handler<T> = (event: unknown, ...args: unknown[]) => T | Promise<T>;

// Wraps a handler so the renderer always receives {ok: true, data} or
// {ok: false, error} instead of an opaque rejected promise.
const wrap =
  <T>(handler: Handler<T>) =>
  async (event: unknown, ...args: unknown[]): Promise<ipc.IpcResult<T>> => {
    try {
      return { ok: true, data: await handler(event, ...args) };
    } catch (error) {
      return toFailure(error);
    }
  };

// The work package store's state for one package.
type PackageState = ReturnType<WorkPackageStore['get']>;

// The stores type some persisted fields more loosely than the wire contract
// (QA's report and diff as unknown, reason codes as strings). These casts are
// the one place their state becomes the contract.
const toWireState = (state: PackageState) => state as ipc.WorkPackageState;
const toWireRequirement = (item: Requirement) => item as ipc.Requirement;

// `task` is the effective definition (WorkPackageStore.effective()).
export const buildTaskView = (task: TaskDefinition, packageState: PackageState): ipc.TaskView => {
  const state = toWireState(packageState);
  return {
    ...task,
    status: state.status,
    statusLabel: label(state.status),
    baseline: state.baseline,
    claimedAt: state.claimedAt,
    completedSteps: state.completedSteps,
    deviations: state.deviations,
    review: state.review ?? null,
    baselineChecks: state.baselineChecks ?? null,
    adjudication: state.adjudication ?? null,
    codingRun: state.codingRun ?? null,
    revision: state.revision && {
      version: state.revision.version,
      reason: state.revision.reason,
      changes: state.revision.changes,
      revisedAt: state.revision.revisedAt,
    },
    // Filtered to the human actor, so only human transitions remain.
    humanTransitions: humanTransitions(packageState) as ipc.HumanTransition[],
  };
};

// The agent transition that moved a package from `from` to `to`; the store
// picks it, so it is looked up rather than passed back.
const agentTransitionOf = (from: ipc.WorkPackageStatus, to: ipc.WorkPackageStatus) =>
  TRANSITIONS.find((transition) => transition.actor === 'agent' && transition.from === from && transition.to === to)?.name as ipc.AgentTransition;

// Electron's ipcMain, or a stand-in exposing `handle`.
export type IpcMainLike = { handle(channel: Channel, listener: (event: unknown, ...args: unknown[]) => unknown): void };

type RunAgent = claudeCli.RunAgent;

export type IpcDeps = {
  store: WorkPackageStore;
  // userData: preferences and the repository registry live here.
  configDir: string;
  // Known repositories; each keeps its own data directory.
  repositories: RepositoryRegistry;
  // In-memory accessors for the loaded config.
  getConfig: () => workspace.WorkspaceConfig;
  setConfig: (config: workspace.WorkspaceConfig) => void;
  pickDirectory?: (defaultPath: string | null) => Promise<string | null>;
  // In-memory accessors for preferences.
  getPreferences?: () => preferences.Preferences;
  setPreferences?: (prefs: preferences.Preferences) => void;
  // From shell_env.createPathResolver().
  pathResolver?: ReturnType<typeof createPathResolver>;
  // E.g. to apply the theme to native windows.
  onPreferencesChanged?: (next: preferences.Preferences, previous: preferences.Preferences) => void;
  // Opens a folder in the OS.
  revealPath?: (dir: string) => Promise<void>;
  // Shows a workspace file in the OS file manager (shell.showItemInFolder).
  revealFile?: (file: string) => void;
  // Replaces how open_file.ts starts the editor (tests).
  launchEditor?: (file: string, args: string[]) => Promise<void>;
  // Shown on the environment page.
  appVersion?: string;
  // Enables the requirement flow.
  requirements?: RequirementStore | null;
  // Replaces claude-cli.runStructured (tests).
  runAgent?: RunAgent;
  probeAgent?: typeof cliRunner.probeCli;
  modelCatalog?: typeof readModelCatalog;
  // Called after generated packages are added to the queue.
  onPackagesPublished?: (definitions: TaskDefinition[]) => void;
  // Records state changes for metrics and the activity feed.
  activity?: ActivityLog | null;
  // Enables Release Manager.
  releases?: ReleaseStore | null;
  // Enables Tutor.
  tutor?: TutorStore | null;
  codingProbe?: typeof codingExec.probeRuntime;
  codingPrepare?: typeof codingWorkspace.prepare;
  codingRun?: typeof codingExec.runCoding;
  codingReadPatch?: typeof codingWorkspace.readPatch;
  codingApplyPatch?: typeof codingWorkspace.applyPatch;
  codingClean?: typeof codingWorkspace.clean;
  codingSnapshot?: typeof codingWorkspace.snapshotBaseline;
};

export type IpcHandle = { shutdown: () => Promise<void> };

type CodingRuntime = {
  run: ipc.CodingRun;
  controller: AbortController;
  events: ipc.CodingEvent[];
  workspace: codingWorkspace.PreparedCodingWorkspace;
};

export const registerIpcHandlers = (ipcMain: IpcMainLike, deps: IpcDeps): IpcHandle => {
  const {
    store,
    configDir,
    repositories,
    getConfig,
    setConfig,
    pickDirectory,
    getPreferences = () => preferences.defaults(),
    setPreferences = () => {},
    pathResolver = createPathResolver(),
    onPreferencesChanged,
    revealPath,
    revealFile,
    launchEditor,
    appVersion,
    requirements = null,
    runAgent,
    probeAgent = cliRunner.probeCli,
    modelCatalog = readModelCatalog,
    onPackagesPublished,
    activity = null,
    releases = null,
    tutor = null,
    codingProbe = codingExec.probeRuntime,
    codingPrepare = codingWorkspace.prepare,
    codingRun = codingExec.runCoding,
    codingReadPatch = codingWorkspace.readPatch,
    codingApplyPatch = codingWorkspace.applyPatch,
    codingClean = codingWorkspace.clean,
    codingSnapshot = codingWorkspace.snapshotBaseline,
  } = deps;

  // The PATH verification commands run with, per the user's preference.
  const commandPath = () => pathResolver.resolve(getPreferences().environment.pathSource);

  // Freeze a role's runtime at the start of its background action. Saving the
  // next settings must not change an Architect step halfway through a run.
  const runnerFor = (agent: Exclude<AgentId, 'coding-agent'>): RunAgent => {
    const config = { ...getPreferences().agents[agent] };
    return (options) => {
      if (!supportsAgentConfig(agent, config)) throw codedError('The selected CLI cannot safely run this analysis agent', 'agent_unavailable');
      return runAgent
        ? runAgent({ ...options, command: config.cli, model: config.model || null, thinking: config.thinking })
        : cliRunner.runStructured(options, config);
    };
  };

  const failWith: (message: string, code: string, field?: string) => never = (message, code, field) => {
    throw codedError(message, code, field);
  };

  // Parses and checks a settings form. The root must be an absolute path to
  // an existing directory inside a git repository; it is then normalized to
  // the repository's top level, because git reports diff paths relative to
  // that and file scopes would otherwise never match.
  const validateRoot = async (candidate: unknown) => {
    const root = requireString(candidate, 'root').trim();
    if (!path.isAbsolute(root)) failWith('Workspace root must be an absolute path', 'root_not_absolute', 'root');
    let stat;
    try {
      stat = await fs.stat(root);
    } catch {
      return failWith(`Directory not found: ${root}`, 'root_not_found', 'root');
    }
    if (!stat.isDirectory()) failWith(`Not a directory: ${root}`, 'root_not_found', 'root');
    if (!(await git.isRepo(root))) failWith('Workspace root is not a git repository', 'not_a_repo', 'root');
    const top = await git.topLevel(root);
    return { root: top, repo: await git.describe(top) };
  };

  // Parses and checks a settings form. The root is the open repository's,
  // whatever the form says: repositories are added and moved through
  // repositories:add and repositories:relocate.
  const validateForm = async (form: unknown) => {
    const config = workspace.fromForm(form as workspace.WorkspaceFormInput, getConfig());
    config.root = getConfig().root;
    const info: { repo: ipc.RepoInfo | null } = { repo: null };
    if (!config.root) return { config, info };
    const checked = await validateRoot(config.root);
    config.root = checked.root;
    info.repo = checked.repo;
    return { config, info };
  };

  const requireRoot = () => {
    const { root } = getConfig();
    if (!root) throw codedError('No workspace root is configured', 'no_workspace');
    return root;
  };

  // Resolves a renderer-supplied path, refusing anything outside the root.
  const safePath = (root: string, candidate: unknown) => {
    const checked = requireString(candidate, 'path');
    if (!workspace.isInside(root, checked)) throw codedError(`Path is outside the workspace: ${checked}`, 'path_outside_workspace');
    return checked;
  };

  const requireBaseline = (id: string) => {
    const state = store.get(id);
    if (!state.baseline) throw codedError('Work package has no baseline; claim it first', 'no_baseline');
    return state.baseline;
  };

  // The definition as currently planned, including Architect's replans.
  const effectiveTask = (id: string) => {
    const task = tasks.getTask(id);
    return task ? store.effective(task) : null;
  };

  // Activity is a side record: a failed append is logged and never fails the
  // action that caused it.
  const record = (event: LoggedEvent) => {
    activity?.append(event).catch((error) => console.error('[activity] append failed', error));
  };

  // One agent run's spend, for the team page's weekly total. Free runs (the
  // outcome was certain without the model) record nothing.
  const recordCost = (agent: ipc.ActivityAgent, costUsd: number) => {
    if (costUsd > 0) record({ kind: 'agent_cost', agent, costUsd });
  };

  // Records a package moving between statuses.
  const recordTransition = (
    id: string,
    before: ipc.WorkPackageStatus,
    after: { status: ipc.WorkPackageStatus },
    transition: ipc.HumanTransition | ipc.AgentTransition | ipc.CodingTransition,
    actor: 'human' | 'agent' | 'coding-agent',
  ) => {
    if (before === after.status) return;
    record({ kind: 'package_transition', packageId: id, title: tasks.getTask(id)?.title ?? id, transition, actor, from: before, to: after.status });
  };

  const requireTask = (id: string) => {
    const task = effectiveTask(id);
    if (!task) throw codedError(`Unknown work package: ${id}`, 'unknown_package');
    return task;
  };

  ipcMain.handle(
    CHANNELS.listTasks,
    wrap((): ipc.TaskView[] => {
      const state = store.all();
      return tasks.listTasks().map((task) => buildTaskView(store.effective(task), state[task.id]));
    }),
  );

  ipcMain.handle(
    CHANNELS.getTask,
    wrap((_event, id): ipc.TaskView => {
      const checked = requireString(id, 'id');
      return buildTaskView(requireTask(checked), store.get(checked));
    }),
  );

  // Background run promises, so shutdown (and tests) can wait for writes.
  const pendingRuns = new Set<Promise<unknown>>();
  const track = (promise: Promise<unknown>) => {
    pendingRuns.add(promise);
    promise.finally(() => pendingRuns.delete(promise));
  };

  const codingRuns = new Map<string, CodingRuntime>();
  // Submit checks running on an applied patch, per package.
  const codingVerifications = new Map<string, AbortController>();
  const codingEventHistory = new Map<string, ipc.CodingEvent[]>();
  const MAX_CODING_EVENTS = 200;
  const codingStatus = () => codingProbe({ config: { ...getPreferences().agents['coding-agent'] } });
  const codingRunOf = (id: string) => {
    const task = requireTask(id);
    const run = store.get(id).codingRun ?? codingRuns.get(id)?.run;
    if (!run) throw codedError('No coding run exists', 'coding_not_running');
    return { task, run };
  };
  const codingWorkspaceOf = (id: string, run: CodingRun) => codingRuns.get(id)?.workspace ?? { runName: run.runName, directory: run.runName };
  const codingPrompt = (task: TaskDefinition, instruction: string, feedback: string | null) =>
    [
      'You are TaskPilot Coding Agent. Work only in the current isolated repository.',
      'Do not commit, push, change git remotes, or modify files outside the requested scope.',
      `Requested files: ${task.fileScope.join(', ') || '(none)'}`,
      `Work package: ${task.title}`,
      `Steps: ${task.steps.join(' | ')}`,
      `Acceptance: ${task.acceptance.map((item) => item.text).join(' | ')}`,
      `Developer instruction: ${instruction}`,
      ...(feedback ? ['', 'The repository already contains your previous attempt.', feedback] : []),
    ].join('\n');
  const updateCoding = async (id: string, patch: Partial<CodingRun>) => {
    const state = await store.updateCodingRun(id, patch);
    const runtime = codingRuns.get(id);
    if (runtime?.run) runtime.run = state.codingRun as CodingRun;
    return state;
  };
  const codingFailure = (error: unknown): ipc.ErrorInfo => ({
    code: errorCode(error) ?? 'coding_failed',
    message: error instanceof Error ? error.message : String(error),
  });
  // A new round may start once the previous one has finished or handed its
  // patch over; ready (unapplied) and in-flight rounds block it.
  const CODING_STARTABLE: ipc.CodingRunStatus[] = ['failed', 'cancelled', 'discarded', 'applied', 'submitted'];
  const startCoding = async (id: string, rawInput: unknown): Promise<ipc.TaskView> => {
    const input = rawInput as { instruction?: unknown } | null | undefined;
    const instruction = requireString(input?.instruction, 'instruction').trim();
    if (instruction.length > 20_000) failWith('Instruction is too long', 'invalid_argument', 'instruction');
    return startRound(id, { instruction, trigger: 'human', feedback: null });
  };
  // One coding round. The developer's round starts a chain at attempt 1;
  // automatic rounds continue it with feedback, from the current working tree.
  const startRound = async (
    id: string,
    { instruction, trigger, feedback }: { instruction: string; trigger: ipc.CodingTrigger; feedback: string | null },
  ): Promise<ipc.TaskView> => {
    const runtimeConfig = { ...getPreferences().agents['coding-agent'] };
    const task = requireTask(id);
    const state = store.get(id);
    if (state.status !== 'in_progress') failWith('Coding Agent can only run on an in-progress package', 'invalid_state');
    if (codingRuns.has(id) || codingVerifications.has(id)) failWith('A Coding Agent run is already active', 'coding_running');
    const previous = state.codingRun;
    if (previous && !CODING_STARTABLE.includes(previous.status)) failWith('This package already has a Coding Agent result', 'coding_result_exists');
    const root = requireRoot();
    // The developer's own edits and earlier applied rounds are part of the start.
    const baseline = await codingSnapshot(root, requireBaseline(id), task.fileScope);
    const chained = trigger !== 'human' && previous;
    const runId = codingExec.codingRunId();
    const initial: CodingRun = {
      id: runId,
      packageId: id,
      runName: path.join(codingWorkspace.DEFAULT_RUN_ROOT, runId),
      baseline,
      status: 'preparing',
      user: codingExec.CODING_USER,
      model: runtimeConfig.model,
      cli: runtimeConfig.cli,
      thinking: runtimeConfig.thinking,
      runtimeVersion: null,
      sessionId: null,
      instruction,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      error: null,
      output: '',
      usage: { inputTokens: null, outputTokens: null, cachedInputTokens: null, reasoningTokens: null, costUsd: null },
      files: [],
      blocked: [],
      checks: {},
      patchDigest: null,
      attempt: chained ? previous.attempt + 1 : 1,
      trigger,
      feedback,
      halt: null,
      rounds: chained ? [...previous.rounds, codingLoop.roundOf(previous)] : [],
    };
    await store.setCodingRun(id, initial);
    record({ kind: 'coding_run', packageId: id, title: task.title, status: 'started', costUsd: null });
    const controller = new AbortController();
    const runtime: CodingRuntime = {
      run: initial,
      controller,
      events: [],
      workspace: { runName: initial.runName, directory: initial.runName },
    };
    codingRuns.set(id, runtime);
    codingEventHistory.set(id, []);
    const settled = (async () => {
      let prepared: codingWorkspace.PreparedCodingWorkspace | null = null;
      try {
        prepared = await codingPrepare(root, baseline, { runName: initial.runName, signal: controller.signal });
        if (controller.signal.aborted) throw Object.assign(new Error('Coding run was cancelled'), { code: 'coding_aborted' });
        runtime.workspace = prepared;
        await updateCoding(id, { status: 'running' });
        const result = await codingRun({
          runName: prepared.runName,
          config: runtimeConfig,
          prompt: codingPrompt(task, instruction, feedback),
          timeoutMs: 30 * 60 * 1000,
          signal: controller.signal,
          onEvent: (event) => {
            runtime.events.push(event);
            if (runtime.events.length > MAX_CODING_EVENTS) runtime.events = runtime.events.slice(-MAX_CODING_EVENTS);
          },
        });
        runtime.events = result.events.map((event, sequence) => ({ ...event, sequence })).slice(-MAX_CODING_EVENTS);
        codingEventHistory.set(id, [...runtime.events]);
        await updateCoding(id, { status: 'checking', output: result.output, usage: result.usage, sessionId: result.sessionId });
        const preview = await codingReadPatch(prepared.runName, task.fileScope, { signal: controller.signal });
        await updateCoding(id, {
          status: 'ready',
          finishedAt: new Date().toISOString(),
          files: preview.files,
          blocked: preview.blocked,
          patchDigest: preview.digest,
        });
        record({ kind: 'coding_run', packageId: id, title: task.title, status: 'finished', costUsd: result.usage.costUsd });
        if (result.usage.costUsd !== null) recordCost('coding-agent', result.usage.costUsd);
      } catch (error) {
        const cancelled = controller.signal.aborted || errorCode(error) === 'coding_aborted' || errorCode(error) === 'workspace_aborted';
        await updateCoding(id, {
          status: cancelled ? 'cancelled' : 'failed',
          finishedAt: new Date().toISOString(),
          error: codingFailure(error),
        }).catch(() => {});
        record({ kind: 'coding_run', packageId: id, title: task.title, status: cancelled ? 'cancelled' : 'failed', costUsd: null });
      } finally {
        codingEventHistory.set(id, [...runtime.events]);
        const current = store.get(id).codingRun;
        if (prepared && current && current.status !== 'ready' && current.status !== 'applied') await codingClean(prepared.runName).catch(() => {});
        codingRuns.delete(id);
      }
      // Automatic rounds go on by themselves; the developer's round waits for
      // a per-file review.
      if (trigger !== 'human' && store.get(id).codingRun?.status === 'ready') continueLoop(id, () => autoApplyRound(id));
    })();
    track(settled);
    return buildTaskView(task, store.get(id));
  };

  // An automatic round's patch: applied whole unless it touches a high-risk
  // path, which stops the loop for the developer.
  const autoApplyRound = async (id: string) => {
    const { task, run } = codingRunOf(id);
    const preview = await codingReadPatch(run.runName, task.fileScope);
    const decision = codingLoop.autoApply(preview);
    if (decision.highRisk) return void (await updateCoding(id, { halt: 'high_risk' }));
    if (!decision.files.length) {
      await codingClean(run.runName).catch((error) => console.error(error));
      return void (await updateCoding(id, { status: 'discarded', halt: 'no_changes' }));
    }
    await applyRound(id, preview, decision.files, false);
    await verifyApplied(id);
  };

  // Applies the chosen files of a ready patch to the working tree.
  const applyRound = async (id: string, preview: ipc.CodingPatchPreview, files: string[], allowHighRisk: boolean): Promise<string[]> => {
    const { task, run } = codingRunOf(id);
    const selected = codingWorkspace.parsePatchPreview(codingWorkspace.selectPatch(preview.patch, files), task.fileScope);
    const blocked = allowHighRisk ? selected.blocked.filter((entry) => entry.reason !== 'high-risk project control or test path') : selected.blocked;
    await updateCoding(id, { status: 'applying', error: null });
    try {
      const applied = await codingApplyPatch(requireRoot(), selected.patch, selected.digest, blocked);
      await updateCoding(id, {
        status: 'verifying',
        finishedAt: new Date().toISOString(),
        files: selected.files,
        blocked: preview.blocked,
        patchDigest: selected.digest,
        halt: null,
      });
      await codingClean(run.runName).catch((error) => console.error(error));
      return applied;
    } catch (error) {
      await updateCoding(id, { status: 'ready', error: codingFailure(error) });
      throw error;
    }
  };

  // Runs the submit checks on the applied patch with the developer's
  // permissions. A clean run hands the package to QA; a blocking failure
  // starts the next round while attempts remain.
  const verifyApplied = async (id: string) => {
    const controller = new AbortController();
    codingVerifications.set(id, controller);
    const config = getConfig();
    const baselines = store.get(id).baselineChecks?.checks ?? {};
    const failures: Parameters<typeof codingLoop.checksFeedback>[0] = [];
    const runs: ipc.CodingRun['checks'] = {};
    try {
      const { path: envPath } = await commandPath();
      for (const check of submitChecks(config)) {
        if (controller.signal.aborted) break;
        let outcome: Parameters<typeof evidence.evaluate>[1];
        try {
          const run = await verification.runCheck(config, check.kind, { signal: controller.signal, envPath });
          // runCheck() echoes the kind it ran, which is a CheckKind here.
          runs[check.kind] = { ...run, kind: check.kind };
          outcome = run;
        } catch (error) {
          outcome = { error: { code: errorCode(error) ?? 'not_run', message: error instanceof Error ? error.message : String(error) } };
        }
        const item = evidence.evaluate(check, outcome, evidence.usableBaseline(baselines[check.kind], check.line));
        if (item.status === 'fail' && check.blocking) failures.push({ evidence: item, run: runs[check.kind] ?? null });
      }
    } finally {
      codingVerifications.delete(id);
    }
    if (controller.signal.aborted) return void (await updateCoding(id, { status: 'applied', checks: runs, halt: 'stopped' }));
    const run = (await updateCoding(id, { checks: runs })).codingRun as CodingRun;
    if (failures.length) {
      if (!codingLoop.canRetry(run)) return void (await updateCoding(id, { status: 'applied', halt: 'attempts_exhausted' }));
      await updateCoding(id, { status: 'applied' });
      await startRound(id, { instruction: run.instruction, trigger: 'checks_failed', feedback: codingLoop.checksFeedback(failures) });
      return;
    }
    await updateCoding(id, { status: 'submitted' });
    const before = store.get(id).status;
    const entry = await store.transition(id, 'coding_submitted', 'coding-agent');
    recordTransition(id, before, entry, 'coding_submitted', 'coding-agent');
    await startReview(id).catch(async (error) => {
      console.error(error);
      await store.failReview(id, asAgentError(error)).catch((failure) => console.error(failure));
    });
  };

  // Runs one automatic step of the loop in the background. A failure stops
  // the loop with the error on the run, never silently.
  const continueLoop = (id: string, step: () => Promise<void>) =>
    track(
      step().catch(async (error) => {
        console.error(error);
        if (store.get(id).codingRun) await updateCoding(id, { halt: 'stopped', error: codingFailure(error) }).catch((failure) => console.error(failure));
      }),
    );

  // After QA sends a Coding Agent submission back, the next round takes its
  // issues while attempts remain.
  const continueAfterReview = async (id: string) => {
    const state = store.get(id);
    const run = state.codingRun;
    if (state.status !== 'in_progress' || run?.status !== 'submitted' || state.review?.status !== 'rejected') return;
    if (!codingLoop.canRetry(run)) return void (await updateCoding(id, { halt: 'attempts_exhausted' }));
    const { reasons = [], report = null, checks = [] } = state.review;
    const feedback = codingLoop.reviewFeedback({ reasons, report: report as ipc.QaReport | null, checks });
    await startRound(id, { instruction: run.instruction, trigger: 'qa_rejected', feedback });
  };

  ipcMain.handle(
    CHANNELS.codingStatus,
    wrap(() => codingStatus()),
  );
  ipcMain.handle(
    CHANNELS.codingStart,
    wrap((_event, rawId, input): Promise<ipc.TaskView> => startCoding(requireString(rawId, 'id'), input)),
  );
  ipcMain.handle(
    CHANNELS.codingGet,
    wrap((_event, rawId): ipc.TaskView => {
      const id = requireString(rawId, 'id');
      return buildTaskView(requireTask(id), store.get(id));
    }),
  );
  ipcMain.handle(
    CHANNELS.codingEvents,
    wrap((_event, rawId, rawAfter): CodingEventPage => {
      const id = requireString(rawId, 'id');
      codingRunOf(id);
      if (!Number.isInteger(rawAfter) || (rawAfter as number) < -1) failWith('after must be a non-negative sequence or -1', 'invalid_argument', 'after');
      const all = codingRuns.get(id)?.events ?? codingEventHistory.get(id) ?? [];
      const after = rawAfter as number;
      const events = all.filter((event) => event.sequence > after).slice(0, 200);
      const next = events.at(-1)?.sequence ?? after;
      return { events, next, truncated: events.length > 0 && all.some((event) => event.sequence > next) };
    }),
  );
  ipcMain.handle(
    CHANNELS.codingCancel,
    wrap(async (_event, rawId): Promise<boolean> => {
      const id = requireString(rawId, 'id');
      const runtime = codingRuns.get(id);
      const verifying = codingVerifications.get(id);
      if (verifying) {
        verifying.abort();
        return true;
      }
      if (!runtime) {
        const run = store.get(id).codingRun;
        if (!run || run.status !== 'ready') return false;
        await codingClean(run.runName).catch(() => {});
        await updateCoding(id, { status: 'discarded', finishedAt: new Date().toISOString(), halt: run.trigger === 'human' ? null : 'stopped' });
        return true;
      }
      runtime.controller.abort();
      if (runtime.run.trigger !== 'human') await updateCoding(id, { halt: 'stopped' }).catch((error) => console.error(error));
      return true;
    }),
  );
  ipcMain.handle(
    CHANNELS.codingPatch,
    wrap(async (_event, rawId): Promise<ipc.CodingPatchPreview> => {
      const id = requireString(rawId, 'id');
      const { task, run } = codingRunOf(id);
      if (!['ready', 'applied'].includes(run.status)) failWith('Coding patch is not ready', 'coding_not_ready');
      const preview = await codingReadPatch(codingWorkspaceOf(id, run).runName, task.fileScope);
      await updateCoding(id, { files: preview.files, blocked: preview.blocked, patchDigest: preview.digest });
      return preview;
    }),
  );
  ipcMain.handle(
    CHANNELS.codingApply,
    wrap(async (_event, rawId, rawInput): Promise<ipc.CodingApplyResult> => {
      const id = requireString(rawId, 'id');
      const { task, run } = codingRunOf(id);
      if (run.status !== 'ready') failWith('Coding patch is not ready to apply', 'coding_not_ready');
      const input = rawInput as { digest?: unknown; allowHighRisk?: unknown; files?: unknown } | null | undefined;
      const digest = requireString(input?.digest, 'digest');
      if (input?.allowHighRisk !== true && input?.allowHighRisk !== false) failWith('allowHighRisk must be boolean', 'invalid_argument', 'allowHighRisk');
      const files = input.files;
      if (!Array.isArray(files) || !files.length || files.some((file) => typeof file !== 'string'))
        failWith('files must be a non-empty list of paths', 'invalid_argument', 'files');
      const preview = await codingReadPatch(codingWorkspaceOf(id, run).runName, task.fileScope);
      if (preview.digest !== digest) failWith('Patch changed since preview', 'coding_digest_mismatch');
      const applied = await applyRound(id, preview, files as string[], input.allowHighRisk);
      record({ kind: 'coding_run', packageId: id, title: task.title, status: 'finished', costUsd: run.usage.costUsd });
      codingRuns.delete(id);
      continueLoop(id, () => verifyApplied(id));
      return { files: applied };
    }),
  );

  // QA: reviews a package once it is submitted.

  // QA: reviews a package once it is submitted.

  // One in-flight review per work package, so it can be cancelled.
  const reviews = new Map<string, AbortController>();

  // The Architect summary of the requirement a package came from, if any.
  const interfacesFor = (task: TaskDefinition & { requirementId?: string }) => {
    if (!requirements || !task.requirementId) return null;
    try {
      return requirements.get(task.requirementId).interfaces?.text ?? null;
    } catch {
      return null;
    }
  };

  // Starts QA in the background. The renderer polls tasks:get for the
  // outcome; QA moves the package on itself when it finishes.
  const startReview = async (id: string) => {
    const task = requireTask(id);
    const root = requireRoot();
    const baseline = requireBaseline(id);
    const reviewRunner = runnerFor('qa');
    const entry = await store.beginReview(id);
    const controller = new AbortController();
    reviews.set(id, controller);
    const config = getConfig();
    const settled = (async () => {
      let outcome: { result: Awaited<ReturnType<typeof reviewWorkPackage>> } | { error: unknown };
      try {
        const { path: envPath } = await commandPath();
        const result = await reviewWorkPackage(task, {
          root,
          baseline,
          runAgent: reviewRunner,
          checks: submitChecks(config),
          runCheck: (kind: string, signal?: AbortSignal) => verification.runCheck(config, kind, { signal, envPath }),
          baselines: store.get(id).baselineChecks?.checks ?? {},
          ignore: reportIgnore(config),
          interfaces: interfacesFor(task),
          envPath,
          signal: controller.signal,
        });
        throwIfCancelled(controller.signal);
        outcome = { result };
      } catch (error) {
        outcome = { error: controller.signal.aborted ? Object.assign(new Error('The review was cancelled'), { code: 'agent_cancelled' }) : error };
      }
      // Drop the run first, so nobody sees a finished review that still
      // looks cancellable.
      reviews.delete(id);
      if ('error' in outcome) await store.failReview(id, asAgentError(outcome.error)).catch(() => {});
      else {
        const before = store.get(id).status;
        recordCost('qa', outcome.result.costUsd);
        await store
          .completeReview(id, outcome.result)
          .then((after) => recordTransition(id, before, after, agentTransitionOf(before, after.status), 'agent'))
          .then(
            () => continueLoop(id, () => continueAfterReview(id)),
            (error) => store.failReview(id, error).catch(() => {}),
          );
      }
    })();
    track(settled);
    return toWireState(entry);
  };

  // Architect: rules on a reported deviation.

  const adjudications = new Map<string, AbortController>(); // package id -> AbortController

  // Starts Architect's ruling in the background. Like QA, it moves the
  // package on itself: back to the developer, or to the queue with a new plan.
  // Without a workspace it still runs, on the package text alone.
  const startAdjudication = async (id: string) => {
    const task = requireTask(id);
    // Fixed at the start: a repository switch cancels the run, but the code
    // must never be read from the next repository meanwhile.
    const { root } = getConfig();
    const architectRunner = runnerFor('architect');
    const entry = await store.beginAdjudication(id);
    const controller = new AbortController();
    adjudications.set(id, controller);
    const settled = (async () => {
      let outcome: { result: Awaited<ReturnType<typeof adjudicateDeviation>> } | { error: unknown };
      try {
        const { path: envPath } = await commandPath();
        const result = await adjudicateDeviation(task, {
          root,
          deviations: entry.deviations,
          // beginAdjudication() has just set it.
          mustReplan: entry.adjudication?.mustReplan === true,
          runAgent: architectRunner,
          interfaces: interfacesFor(task),
          envPath,
          signal: controller.signal,
        });
        throwIfCancelled(controller.signal);
        outcome = { result };
      } catch (error) {
        outcome = { error: controller.signal.aborted ? Object.assign(new Error('The adjudication was cancelled'), { code: 'agent_cancelled' }) : error };
      }
      adjudications.delete(id);
      if ('error' in outcome) await store.failAdjudication(id, asAgentError(outcome.error)).catch(() => {});
      else {
        const before = store.get(id).status;
        recordCost('architect', outcome.result.costUsd);
        await store
          .completeAdjudication(id, outcome.result)
          .then((after) => recordTransition(id, before, after, agentTransitionOf(before, after.status), 'agent'))
          .catch((error) => store.failAdjudication(id, error).catch(() => {}));
      }
    })();
    track(settled);
    return toWireState(entry);
  };

  // Baselines: the submit-stage checks run on the claimed commit.

  const baselineRuns = new Map<string, AbortController>(); // package id -> AbortController

  // Tracked files and HEAD; untracked files (build output) are allowed to appear.
  const treeState = async (root: string) => {
    const entries = await git.status(root);
    return {
      head: await git.head(root),
      dirty: entries
        .filter((entry) => !entry.untracked)
        .map((entry) => `${entry.status} ${entry.path}`)
        .sort(),
    };
  };

  // Measures the baseline in the background. It only counts when the tree was
  // clean at the claimed commit before and after: a run over half-edited code
  // would blame or excuse the wrong tests.
  const measureBaseline = async (id: string) => {
    const config = getConfig();
    const root = config.root;
    const commit = store.get(id).baseline;
    if (!root || !commit) return;
    baselineRuns.get(id)?.abort();
    const controller = new AbortController();
    baselineRuns.set(id, controller);
    const checks = submitChecks(config);
    const startedAt = new Date().toISOString();
    const record = (status: BaselineChecksStatus, extra: Partial<BaselineChecks> = {}) =>
      store
        .setBaselineChecks(id, {
          status,
          reason: null,
          commit,
          checks: {},
          startedAt,
          finishedAt: new Date().toISOString(),
          ...extra,
        })
        .catch(() => null);

    const settled = (async () => {
      try {
        if (!checks.length) return void (await record('unavailable', { reason: 'no_checks' }));
        const before = await treeState(root);
        if (before.head !== commit) return void (await record('unavailable', { reason: 'head_moved' }));
        if (before.dirty.length) return void (await record('unavailable', { reason: 'dirty_tree' }));
        await record('measuring', { finishedAt: null });

        const { path: envPath } = await commandPath();
        const results: BaselineChecks['checks'] = {};
        for (const check of checks) {
          if (controller.signal.aborted) break;
          try {
            const run = await verification.runCheck(config, check.kind, { signal: controller.signal, envPath });
            results[check.kind] = evidence.baselineRecord(run, check.line);
          } catch (error) {
            if (controller.signal.aborted) break;
            results[check.kind] = { status: 'unavailable', reason: errorCode(error) ?? 'failed', line: check.line };
          }
        }
        if (controller.signal.aborted) return void (await record('unavailable', { reason: 'cancelled' }));

        const after = await treeState(root);
        const same = after.head === commit && after.dirty.join('\n') === before.dirty.join('\n');
        await record(same ? 'measured' : 'contaminated', same ? { checks: results } : { reason: 'tree_changed' });
      } catch (error) {
        await record('unavailable', { reason: errorCode(error) ?? 'failed' });
      } finally {
        if (baselineRuns.get(id) === controller) baselineRuns.delete(id);
      }
    })();
    track(settled);
    return settled;
  };

  // Re-measuring is for a package claimed on a dirty tree, once it is clean.
  // It is only allowed before the developer has submitted anything.
  ipcMain.handle(
    CHANNELS.baselineMeasure,
    wrap(async (_event, rawId): Promise<ipc.TaskView> => {
      const id = requireString(rawId, 'id');
      requireBaseline(id);
      const state = store.get(id);
      if (state.status !== 'in_progress') failWith('Baselines can only be measured while the package is in progress', 'invalid_state');
      if (baselineRuns.has(id)) failWith('The baseline is already being measured', 'baseline_running');
      measureBaseline(id);
      return buildTaskView(requireTask(id), store.get(id));
    }),
  );

  // `actor` is fixed to 'human': anything arriving from the renderer is a
  // human action by definition, so the renderer cannot claim to be an agent.
  ipcMain.handle(
    CHANNELS.transition,
    wrap(async (_event, rawId, rawName, options): Promise<ipc.WorkPackageState> => {
      const id = requireString(rawId, 'id');
      const name = requireString(rawName, 'name');
      const extra: { baseline?: string; deviation?: DeviationInput } = {};
      if (name === 'claim') extra.baseline = await git.head(requireRoot());
      // The store validates the deviation it is given.
      if (name === 'report_deviation') extra.deviation = (options as { deviation?: DeviationInput } | null | undefined)?.deviation;
      if (name === 'release') baselineRuns.get(id)?.abort();
      // store.transition() rejects names that are not transitions.
      const before = store.get(id).status;
      const entry = await store.transition(id, name as TransitionName, 'human', extra);
      recordTransition(id, before, entry, name as ipc.HumanTransition, 'human');
      if (name === 'claim') {
        measureBaseline(id);
        return toWireState(entry);
      }
      if (name === 'report_deviation' || name === 'override_dismissal') {
        // The report stands even if Architect cannot start; it can be retried.
        try {
          return await startAdjudication(id);
        } catch (error) {
          await store
            .beginAdjudication(id)
            .then(() => store.failAdjudication(id, asAgentError(error)))
            .catch(() => {});
          return toWireState(store.get(id));
        }
      }
      if (name !== 'submit_for_review') return toWireState(entry);
      // The submission stands even if QA cannot start (no workspace, say);
      // the failure is recorded on the review and the user can retry.
      try {
        return await startReview(id);
      } catch (error) {
        await store
          .beginReview(id)
          .then(() => store.failReview(id, asAgentError(error)))
          .catch(() => {});
        return toWireState(store.get(id));
      }
    }),
  );

  ipcMain.handle(
    CHANNELS.reviewRetry,
    wrap((_event, id): Promise<ipc.WorkPackageState> => startReview(requireString(id, 'id'))),
  );

  ipcMain.handle(
    CHANNELS.reviewCancel,
    wrap((_event, id): boolean => {
      const controller = reviews.get(requireString(id, 'id'));
      if (!controller) return false;
      controller.abort();
      return true;
    }),
  );

  ipcMain.handle(
    CHANNELS.deviationRetry,
    wrap((_event, id): Promise<ipc.WorkPackageState> => startAdjudication(requireString(id, 'id'))),
  );

  ipcMain.handle(
    CHANNELS.deviationCancel,
    wrap((_event, id): boolean => {
      const controller = adjudications.get(requireString(id, 'id'));
      if (!controller) return false;
      controller.abort();
      return true;
    }),
  );

  // The store rejects a stepIndex that is not a non-negative integer.
  ipcMain.handle(
    CHANNELS.setStepDone,
    wrap((_event, id, stepIndex, done): Promise<ipc.WorkPackageState> =>
      store.setStepDone(requireString(id, 'id'), stepIndex as number, done === true).then(toWireState),
    ),
  );

  ipcMain.handle(
    CHANNELS.workspaceGet,
    wrap((): ipc.WorkspaceView => toFormView(getConfig())),
  );

  // Validates everything before writing, so a bad path or command is never
  // persisted and reloaded on the next launch.
  ipcMain.handle(
    CHANNELS.workspaceSet,
    wrap(async (_event, form): Promise<ipc.WorkspaceView> => {
      const { config } = await validateForm(form);
      const saved = await repositories.saveConfig(config);
      setConfig(saved);
      return toFormView(saved);
    }),
  );

  // Same validation as saving, plus a PATH lookup for each command, without
  // writing anything. Lets the settings page warn before the user commits.
  ipcMain.handle(
    CHANNELS.workspaceCheck,
    wrap(async (_event, form): Promise<ipc.WorkspaceCheck> => {
      const { config, info } = await validateForm(form);
      const { path: envPath } = await commandPath();
      const commands = {} as ipc.WorkspaceCheck['commands'];
      for (const kind of workspace.COMMAND_KINDS) {
        const entry = config.commands[kind];
        commands[kind] = entry
          ? // Resolve against the PATH commands will actually run with.
            { configured: true, resolved: await workspace.resolveExecutable(entry.command, { cwd: config.root, envPath }) }
          : { configured: false, resolved: null };
      }
      return { root: config.root, repo: info.repo, commands };
    }),
  );

  ipcMain.handle(
    CHANNELS.preferencesGet,
    wrap((): ipc.Preferences => preferences.toView(getPreferences())),
  );

  // preferences.save() validates the raw value strictly.
  ipcMain.handle(
    CHANNELS.preferencesSet,
    wrap(async (_event, raw): Promise<ipc.Preferences> => {
      const previous = getPreferences();
      const saved = await preferences.save(configDir, raw);
      setPreferences(saved);
      // Switching the PATH source should take effect without a restart.
      if (saved.environment.pathSource !== previous.environment.pathSource) pathResolver.refresh();
      onPreferencesChanged?.(saved, previous);
      return preferences.toView(saved);
    }),
  );

  // Reports which PATH verification commands will use and what it contains.
  // `source` lets the page preview a choice before saving it.
  ipcMain.handle(
    CHANNELS.environmentInfo,
    wrap(async (_event, rawOptions): Promise<ipc.EnvironmentInfo> => {
      const options = rawOptions as { source?: unknown; refresh?: unknown } | null | undefined;
      const requested = options?.source ?? getPreferences().environment.pathSource;
      if (!isPathSource(requested)) return failWith(`Unknown PATH source: ${requested}`, 'invalid_argument');
      if (options?.refresh === true) pathResolver.refresh();
      const resolved = await pathResolver.resolve(requested);
      const entries = resolved.path.split(path.delimiter).filter(Boolean);
      return {
        requested,
        source: resolved.source,
        error: resolved.error,
        shell: appEnv.shell,
        entries,
        inheritedCount: pathResolver.inherited.split(path.delimiter).filter(Boolean).length,
        platform: process.platform,
        versions: { app: appVersion ?? null, electron: process.versions.electron ?? null, node: process.versions.node },
      };
    }),
  );

  ipcMain.handle(
    CHANNELS.dataInfo,
    wrap((): ipc.DataInfo => {
      const repoDir = path.relative(configDir, repositories.dataDir());
      return {
        configDir,
        files: [preferences.PREFERENCES_FILENAME, REGISTRY_FILENAME, ...REPO_FILES.map((name) => path.join(repoDir, name))],
        packages: store.summary(),
      };
    }),
  );

  // Only resets execution progress; workspace config and preferences stay.
  ipcMain.handle(
    CHANNELS.dataResetProgress,
    wrap(async (): Promise<ipc.PackageSummary> => {
      // Running reviews would otherwise write their result over the reset.
      for (const controller of reviews.values()) controller.abort();
      for (const controller of adjudications.values()) controller.abort();
      await Promise.allSettled([...pendingRuns]);
      await store.reset();
      return store.summary();
    }),
  );

  ipcMain.handle(
    CHANNELS.dataReveal,
    wrap(async (): Promise<true> => {
      if (!revealPath) return failWith('Opening the folder is unavailable', 'unsupported');
      await revealPath(configDir);
      return true;
    }),
  );

  // Requirements: Product Lead clarifies, plans, and the human publishes.

  // The handlers below use a local `store` for requirements, so keep a
  // separate name for the work package store.
  const workPackages = store;
  // One in-flight run per requirement, so it can be cancelled.
  const runs = new Map<string, AbortController>();

  const requireRequirements = () => {
    if (!requirements) return failWith('Requirements are unavailable', 'unsupported');
    return requirements;
  };

  // Repository paths Product Lead sees: tracked files only (gitignored and
  // untracked files are left out), capped, and never their contents.
  const repositoryFiles = async (root: string | null): Promise<string[]> => {
    if (!root) return [];
    try {
      return await git.listFiles(root, { limit: 400 });
    } catch {
      return [];
    }
  };

  type RequirementItem = Awaited<ReturnType<RequirementStore['get']>>;
  type PromptInput = Omit<RequirementItem, 'interfaces'> & { files: string[]; interfaces: string | null };

  // Runs one Product Lead step in the background and records the outcome.
  const startRun = async <Output>(
    id: string,
    step: ipc.RequirementStep,
    buildPrompt: (input: PromptInput) => string,
    schema: claudeCli.JsonSchema,
    validate: (raw: unknown) => Output,
    finish: (id: string, output: Output, costUsd: number) => Promise<unknown>,
  ) => {
    const store = requireRequirements();
    const architectRunner = runnerFor('architect');
    const productRunner = runnerFor('product-lead');
    const item = await store.begin(id, step);
    const controller = new AbortController();
    runs.set(id, controller);
    const { root } = getConfig();
    const files = await repositoryFiles(root);
    const { path: envPath } = await commandPath();
    // Not awaited: the renderer polls requirements:get for the result.
    const settled = (async () => {
      let outcome: { output: Output; costUsd: number } | { error: unknown };
      try {
        // Architect summarizes the touched code once, during clarification;
        // planning reuses it. Re-clarifying refreshes it.
        let interfaces = item.interfaces?.text ?? null;
        let architectCost = 0;
        if (step === 'clarifying') {
          await store.setPhase(id, 'architect');
          const result = await summarizeForRequirement(item, {
            runAgent: architectRunner,
            root,
            files,
            envPath,
            signal: controller.signal,
          });
          architectCost = result.costUsd;
          recordCost('architect', architectCost);
          await store.setInterfaces(
            id,
            result.summary
              ? { summary: result.summary, text: result.text, read: result.read, skipped: result.skipped, error: null }
              : { summary: null, text: null, read: [], skipped: result.skipped, error: result.error },
          );
          interfaces = result.text;
          await store.setPhase(id, 'product-lead');
        }
        throwIfCancelled(controller.signal);
        const { output, costUsd } = await productRunner({
          prompt: buildPrompt({ ...item, files, interfaces }),
          systemPrompt: productLead.SYSTEM_PROMPT,
          schema,
          envPath,
          signal: controller.signal,
        });
        recordCost('product-lead', costUsd ?? 0);
        outcome = { output: validate(output), costUsd: (costUsd ?? 0) + architectCost };
      } catch (error) {
        outcome = { error };
      }
      // Drop the run before recording the result, so nobody sees a settled
      // requirement that still looks cancellable.
      runs.delete(id);
      const title = store.get(id).title || item.text.slice(0, 40);
      const fail = (error: unknown) => {
        const agentError = asAgentError(error);
        record({ kind: 'requirement_failed', requirementId: id, title, step, code: agentError.code ?? 'unknown' });
        return store.failRun(id, step, agentError).catch(() => {});
      };
      if ('error' in outcome) await fail(outcome.error);
      else {
        const { costUsd } = outcome;
        await finish(id, outcome.output, costUsd)
          .then(() => record({ kind: 'requirement_finished', requirementId: id, title: store.get(id).title || title, step, costUsd }))
          .catch(fail);
      }
    })();
    track(settled);
    return toWireRequirement(item);
  };

  ipcMain.handle(
    CHANNELS.requirementsList,
    wrap((): ipc.Requirement[] => requireRequirements().list().map(toWireRequirement)),
  );

  ipcMain.handle(
    CHANNELS.requirementsGet,
    wrap((_event, id): ipc.Requirement => toWireRequirement(requireRequirements().get(requireString(id, 'id')))),
  );

  // The store validates title and text.
  ipcMain.handle(
    CHANNELS.requirementsCreate,
    wrap(async (_event, rawInput): Promise<ipc.Requirement> => {
      const input = rawInput as { title?: unknown; text?: unknown } | null | undefined;
      const item = await requireRequirements().create({ title: input?.title, text: input?.text });
      record({ kind: 'requirement_created', requirementId: item.id, title: item.title || item.text.slice(0, 40) });
      // Clarification starts right away; the page shows it running.
      return startRun(item.id, 'clarifying', productLead.clarifyPrompt, productLead.CLARIFY_SCHEMA, productLead.validateClarify, (rid, output, cost) =>
        requireRequirements().finishClarify(rid, output, cost),
      );
    }),
  );

  ipcMain.handle(
    CHANNELS.requirementsClarify,
    wrap((_event, id): Promise<ipc.Requirement> =>
      startRun(requireString(id, 'id'), 'clarifying', productLead.clarifyPrompt, productLead.CLARIFY_SCHEMA, productLead.validateClarify, (rid, output, cost) =>
        requireRequirements().finishClarify(rid, output, cost),
      ),
    ),
  );

  // The store checks the answers against the questions.
  ipcMain.handle(
    CHANNELS.requirementsAnswer,
    wrap((_event, id, answers): Promise<ipc.Requirement> => requireRequirements().setAnswers(requireString(id, 'id'), answers).then(toWireRequirement)),
  );

  ipcMain.handle(
    CHANNELS.requirementsPlan,
    wrap(async (_event, id, answers): Promise<ipc.Requirement> => {
      const rid = requireString(id, 'id');
      // Answers submitted with the plan request are saved first, in one step.
      if (answers !== undefined) await requireRequirements().setAnswers(rid, answers);
      return startRun(rid, 'planning', productLead.planPrompt, productLead.PLAN_SCHEMA, productLead.validatePlan, (r, output, cost) =>
        requireRequirements().finishPlan(r, output, cost),
      );
    }),
  );

  ipcMain.handle(
    CHANNELS.requirementsCancel,
    wrap((_event, id): boolean => {
      const controller = runs.get(requireString(id, 'id'));
      if (!controller) return false;
      controller.abort();
      return true;
    }),
  );

  // Publishing turns the reviewed plan into queue entries.
  ipcMain.handle(
    CHANNELS.requirementsPublish,
    wrap(async (_event, id): Promise<ipc.Requirement> => {
      const store = requireRequirements();
      const item = store.get(requireString(id, 'id'));
      if (item.status !== 'reviewing' || !item.plan) return failWith('There is no plan to publish', 'invalid_state');
      const definitions = productLead.toTaskDefinitions(item, item.plan.packages);
      const published = await store.publish(item.id, definitions);
      tasks.setGeneratedTasks(store.publishedPackages());
      workPackages.add(definitions);
      onPackagesPublished?.(definitions);
      record({ kind: 'requirement_published', requirementId: item.id, title: published.title || item.text.slice(0, 40), packageCount: definitions.length });
      return toWireRequirement(published);
    }),
  );

  ipcMain.handle(
    CHANNELS.requirementsRemove,
    wrap(async (_event, id): Promise<true> => {
      const store = requireRequirements();
      const item = store.get(requireString(id, 'id'));
      // Published packages may already be claimed; removing them would orphan
      // that progress, so only unpublished requirements can be deleted.
      if (item.status === 'published') failWith('Published requirements cannot be deleted', 'invalid_state');
      await store.remove(item.id);
      return true;
    }),
  );

  // The feed, the week's metrics, each member's newest events and spend, and
  // who on the team is busy. Metrics, spend and per-member events share one
  // read of the retention window; the feed reads only the newest days.
  const TEAM_RECENT_COUNT = 3;
  ipcMain.handle(
    CHANNELS.activityOverview,
    wrap(async (): Promise<ipc.ActivityOverview> => {
      if (!activity) return failWith('Activity is unavailable', 'unsupported');
      const settings = getPreferences().agents;
      const { path: envPath } = await commandPath();
      const [recent, window, coding, analysis] = await Promise.all([
        activity.recent({ days: RETENTION_DAYS, limit: 20 }),
        activity.window(RETENTION_DAYS),
        codingStatus(),
        Promise.all(
          ['product-lead', 'architect', 'qa', 'release-manager'].map(async (agent) => {
            const config = settings[agent as keyof typeof settings];
            return [agent, supportsAgentConfig(agent as AgentId, config) && Boolean(await workspace.resolveExecutable(config.cli, { envPath }))] as const;
          }),
        ),
      ]);
      const availableByAgent = { ...Object.fromEntries(analysis), 'coding-agent': coding.available } as ipc.TeamStatus['availableByAgent'];
      const work: ipc.AgentWork[] = [
        ...[...runs.keys()].map((id): ipc.AgentWork => {
          const item = requirements?.get(id);
          return { agent: item?.phase === 'architect' ? 'architect' : 'product-lead', kind: 'requirement', label: item?.title || id };
        }),
        ...[...reviews.keys()].map((id): ipc.AgentWork => ({ agent: 'qa', kind: 'review', label: tasks.getTask(id)?.title ?? id })),
        ...[...adjudications.keys()].map((id): ipc.AgentWork => ({ agent: 'architect', kind: 'adjudication', label: tasks.getTask(id)?.title ?? id })),
        ...(releaseController ? [{ agent: 'release-manager', kind: 'release', label: '发布说明' } satisfies ipc.AgentWork] : []),
        ...[...codingRuns.keys()].map((id): ipc.AgentWork => ({ agent: 'coding-agent', kind: 'coding', label: tasks.getTask(id)?.title ?? id })),
      ];
      const now = new Date();
      return {
        recent,
        metrics: computeMetrics(window, now, activity.timeZone),
        team: {
          available: Object.values(availableByAgent).some(Boolean),
          availableByAgent,
          busy: [...new Set(work.map((item) => item.agent))],
          work,
        },
        costs: computeAgentCosts(window, now, activity.timeZone),
        teamRecent: recentByAgent(window, TEAM_RECENT_COUNT),
        timeZone: activity.timeZone,
      };
    }),
  );

  // The full feed, a few business days per page.
  ipcMain.handle(
    CHANNELS.activityPage,
    wrap(async (_event, before): Promise<ipc.ActivityPage> => {
      if (!activity) return failWith('Activity is unavailable', 'unsupported');
      // A day key from an earlier page; anything else starts from today.
      const cursor = typeof before === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(before) ? before : null;
      const page = await activity.page({ before: cursor, minEvents: 50 });
      return { ...page, timeZone: activity.timeZone, retentionDays: RETENTION_DAYS };
    }),
  );

  // Architect's summaries merged by file, beside the tracked tree. Without a
  // workspace the summaries still show, with unknown freshness.
  ipcMain.handle(
    CHANNELS.engineeringMap,
    wrap(async (): Promise<ipc.EngineeringMap> => {
      const root = getConfig().root;
      const [index, paths] = root ? await Promise.all([indexEntries(root), git.listFiles(root, { limit: MAX_TREE_FILES + 1 })]) : [null, []];
      return buildEngineeringMap(requirements?.list() ?? [], index, paths);
    }),
  );

  // Requirements need both configured planning runtimes, never an unrelated
  // hard-coded executable. The settings page probes every role separately.
  ipcMain.handle(
    CHANNELS.agentStatus,
    wrap(async (): Promise<ipc.AgentStatus> => {
      const settings = getPreferences().agents;
      const { path: envPath } = await commandPath();
      const [product, architect] = await Promise.all([probeAgent(settings['product-lead'], envPath), probeAgent(settings.architect, envPath)]);
      return { available: product.available && architect.available, command: product.available ? product.command : null };
    }),
  );
  ipcMain.handle(
    CHANNELS.agentRuntimes,
    wrap(async (): Promise<ipc.AgentRuntimeStatus[]> => {
      const settings = getPreferences().agents;
      const { path: envPath } = await commandPath();
      const probes = new Map<string, Promise<CliProbeResult>>();
      return Promise.all(
        AGENT_IDS.map(async (agent) => {
          const config = { ...settings[agent] };
          if (agent === 'coding-agent') {
            const status = await codingProbe({ config });
            return { agent, config, command: config.cli, available: status.available, version: status.version, reason: status.reason };
          }
          const key = JSON.stringify(config);
          let probing = probes.get(key);
          if (!probing) {
            probing = probeAgent(config, envPath);
            probes.set(key, probing);
          }
          return { agent, config, ...(await probing) };
        }),
      );
    }),
  );

  // Opening settings reads local CLI config only. Refresh invalidates this
  // metadata cache; it never runs inference, auth helpers or remote catalogs.
  const modelCatalogs = new Map<string, Promise<ipc.CliModelCatalog>>();
  ipcMain.handle(
    CHANNELS.agentModels,
    wrap(async (_event, request): Promise<ipc.CliModelCatalog> => {
      if (!request || typeof request !== 'object' || Array.isArray(request)) failWith('Model request must be an object', 'invalid_argument');
      const raw = request as Record<string, unknown>;
      if (!CLI_IDS.includes(raw.cli as ipc.CliId)) failWith('Unknown CLI', 'invalid_argument', 'cli');
      if (raw.scope !== 'analysis' && raw.scope !== 'coding') failWith('Unknown model scope', 'invalid_argument', 'scope');
      if (raw.refresh !== undefined && typeof raw.refresh !== 'boolean') failWith('refresh must be boolean', 'invalid_argument', 'refresh');
      const cli = raw.cli as ipc.CliId;
      const scope = raw.scope as ipc.CliModelScope;
      const key = `${scope}:${cli}`;
      if (raw.refresh === true) modelCatalogs.delete(key);
      let reading = modelCatalogs.get(key);
      if (!reading) {
        reading = modelCatalog(cli, scope);
        modelCatalogs.set(key, reading);
      }
      return reading;
    }),
  );

  ipcMain.handle(
    CHANNELS.workspacePickRoot,
    wrap(async (): Promise<string | null> => {
      if (!pickDirectory) throw codedError('Directory picker is unavailable', 'unsupported');
      return pickDirectory(getConfig().root);
    }),
  );

  ipcMain.handle(
    CHANNELS.workspaceInfo,
    wrap(async (): Promise<ipc.WorkspaceInfo> => {
      const config = getConfig();
      if (!config.root) return { configured: false };
      return { configured: true, root: config.root, ...(await git.describe(config.root)) };
    }),
  );

  // Opens a workspace file in the developer's editor, at a line when given.
  // The path may come from a QA issue (model text); open_file.ts confines it
  // to the workspace after symlinks.
  ipcMain.handle(
    CHANNELS.workspaceOpenFile,
    wrap(async (_event, filePath, line): Promise<ipc.OpenedWith> => {
      if (!revealFile) return failWith('Opening files is unavailable', 'unsupported');
      const root = requireRoot();
      const { path: envPath } = await commandPath();
      // Anything but a number or null is passed as NaN, which open_file.ts rejects as invalid_line.
      const lineNumber = line === null || line === undefined ? null : typeof line === 'number' ? line : Number.NaN;
      return openWorkspaceFile(root, requireString(filePath, 'path'), lineNumber, { envPath, launch: launchEditor, reveal: revealFile });
    }),
  );

  ipcMain.handle(
    CHANNELS.diffStat,
    wrap(async (_event, rawId): Promise<ipc.DiffStat> => {
      const root = requireRoot();
      const id = requireString(rawId, 'id');
      const task = requireTask(id);
      const changes = await git.changesSince(root, requireBaseline(id));
      return {
        changes,
        scope: tasks.checkFileScope(
          task,
          changes.map((c) => c.path),
        ),
      };
    }),
  );

  ipcMain.handle(
    CHANNELS.diffFile,
    wrap(async (_event, id, filePath): Promise<ipc.DiffFile> => {
      const root = requireRoot();
      return git.diffFile(root, requireBaseline(requireString(id, 'id')), safePath(root, filePath));
    }),
  );

  ipcMain.handle(
    CHANNELS.verifyRun,
    wrap(async (_event, kind, taskId): Promise<ipc.VerifyRun> => {
      if (!isCommandKind(kind)) throw codedError(`Unknown verification kind: ${kind}`, 'invalid_argument');
      const config = getConfig();
      // runCheck() echoes the kind it ran, which is a CheckKind here.
      const result = { ...(await verification.runCheck(config, kind, { envPath: (await commandPath()).path })), kind };
      if (!taskId) return result;
      const task = requireTask(requireString(taskId, 'taskId'));
      // runCheck() succeeded, so the check is configured.
      const configured = config.checks[kind] as workspace.Check;
      // The same comparison a review makes, so a manual run reads the same way.
      const check = { kind, stage: configured.stage, blocking: configured.blocking, line: checkLine(configured) };
      const baselines = store.get(task.id).baselineChecks?.checks ?? {};
      const item = evidence.evaluate(check, result, evidence.usableBaseline(baselines[kind], check.line));
      return {
        ...result,
        evidence: item,
        acceptance: evidence.criteriaStatus(task.acceptance ?? [], { [kind]: result }, [item], baselines),
      };
    }),
  );

  // Environment Steward

  type EnvSession = {
    root: string | null;
    status: ipc.EnvStatus;
    facts: Awaited<ReturnType<typeof envSetup.probe>> | null;
    blockers: ReturnType<typeof envSetup.blockers>;
    plan: Awaited<ReturnType<typeof planEnvironment>>['plan'];
    error: ipc.IpcFailure | null;
    costUsd: number;
    allowScripts: boolean;
    results: Partial<Record<ipc.EnvStepId, ipc.EnvStepResult>>;
    running: ipc.EnvStepId | null;
  };

  // One session per app run, in memory only: the plan is cheap to redo and
  // must not outlive the toolchain it was made for.
  let env: EnvSession = {
    root: null,
    status: 'idle',
    facts: null,
    blockers: [],
    plan: null,
    error: null,
    costUsd: 0,
    allowScripts: false,
    results: {},
    running: null,
  };
  let envController: AbortController | null = null;
  const ENV_OUTPUT_CHARS = 4000;

  // A plan only exists alongside the facts it was made from.
  const envSteps = () => (env.plan && env.facts ? envSetup.buildSteps(env.plan, env.facts, { allowScripts: env.allowScripts }) : []);

  const envView = (): ipc.EnvState => ({
    root: env.root,
    status: env.status,
    stale: Boolean(env.root && env.root !== getConfig().root),
    facts: env.facts && {
      ...env.facts,
      workflows: env.facts.workflows.map((file) => file.path),
      versionFiles: env.facts.versionFiles,
    },
    blockers: env.blockers,
    plan: env.plan,
    error: env.error,
    costUsd: env.costUsd,
    allowScripts: env.allowScripts,
    running: env.running,
    steps: envSteps().map((step) => ({
      id: step.id,
      kind: step.kind,
      script: 'script' in step ? step.script : null,
      line: workspace.formatCommandLine(step),
      result: env.results[step.id] ?? null,
    })),
    configured: Object.fromEntries(
      workspace.COMMAND_KINDS.map((kind) => [kind, workspace.formatCommandLine(getConfig().commands[kind])]),
    ) as ipc.EnvState['configured'],
  });

  const requireEnvPlan = () => {
    if (env.status !== 'ready' || !env.plan) return failWith('No environment plan is ready', 'env_no_plan');
    if (env.root !== getConfig().root) failWith('The workspace changed since this plan was made', 'env_stale');
    if (env.running) failWith('A setup step is already running', 'env_busy');
    return env.plan;
  };

  ipcMain.handle(
    CHANNELS.envGet,
    wrap((): ipc.EnvState => envView()),
  );

  ipcMain.handle(
    CHANNELS.envPlan,
    wrap(async (_event, options): Promise<ipc.EnvState> => {
      const root = requireRoot();
      const stewardRunner = runnerFor('env-steward');
      if (env.status === 'planning' || env.running) failWith('The Environment Steward is busy', 'env_busy');
      // Re-planning after a failure hands the steward that step's output.
      let failure: EnvFailure | null = null;
      if ((options as { withFailure?: unknown } | null | undefined)?.withFailure === true && env.root === root) {
        const failed = envSteps().find((step) => env.results[step.id] && !env.results[step.id]?.ok);
        const result = failed && env.results[failed.id];
        if (failed && result) {
          failure = {
            step: failed.id,
            command: workspace.formatCommandLine(failed),
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            output: result.output,
          };
        }
      }
      const keepResults = failure !== null;
      env = {
        root,
        status: 'planning',
        facts: null,
        blockers: [],
        plan: null,
        error: null,
        costUsd: 0,
        allowScripts: keepResults ? env.allowScripts : false,
        results: keepResults ? env.results : {},
        running: null,
      };
      const session = env;
      const controller = new AbortController();
      envController = controller;
      const { path: envPath } = await commandPath();
      track(
        (async () => {
          try {
            const outcome = await planEnvironment({ root, runAgent: stewardRunner, envPath, signal: controller.signal, failure });
            Object.assign(session, { status: 'ready', facts: outcome.facts, blockers: outcome.blockers, plan: outcome.plan, costUsd: outcome.costUsd });
            // Results only carry over for steps the new plan still runs unchanged.
            const lines = new Map(envSteps().map((step) => [step.id, workspace.formatCommandLine(step)]));
            for (const id of Object.keys(session.results) as ipc.EnvStepId[]) {
              if (session.results[id]?.line !== lines.get(id)) delete session.results[id];
            }
          } catch (error) {
            Object.assign(session, { status: 'failed', error: toFailure(error).error });
          } finally {
            if (envController === controller) envController = null;
          }
        })(),
      );
      return envView();
    }),
  );

  ipcMain.handle(
    CHANNELS.envSetAllowScripts,
    wrap((_event, allow): ipc.EnvState => {
      if (env.running) failWith('A setup step is already running', 'env_busy');
      env.allowScripts = allow === true;
      delete env.results.install;
      return envView();
    }),
  );

  // The click is the user's confirmation; the command itself is rebuilt here
  // from the stored plan, never taken from the renderer.
  ipcMain.handle(
    CHANNELS.envRunStep,
    wrap(async (_event, stepId): Promise<ipc.EnvState> => {
      requireString(stepId, 'stepId');
      requireEnvPlan();
      const step = envSteps().find((candidate) => candidate.id === stepId);
      if (!step) return failWith(`Unknown setup step: ${stepId}`, 'invalid_argument');
      const blocking = env.blockers.filter((code) => code !== 'unsupported_manager' || step.kind === 'install');
      if (blocking.length) failWith(`Setup is blocked: ${blocking.join(', ')}`, 'env_blocked');

      const session = env;
      const controller = new AbortController();
      envController = controller;
      session.running = step.id;
      const line = workspace.formatCommandLine(step);
      const run = (async () => {
        try {
          const result = await verification.run({ root: session.root, commands: { [step.kind]: { command: step.command, args: step.args } } }, step.kind, {
            signal: controller.signal,
            envPath: (await commandPath()).path,
            timeoutMs: 15 * 60 * 1000,
          });
          session.results[step.id] = {
            line,
            ok: result.exitCode === 0 && !result.timedOut,
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            durationMs: result.durationMs,
            summary: step.kind === 'install' ? null : result.summary,
            output: result.output.slice(-ENV_OUTPUT_CHARS),
            at: new Date().toISOString(),
          };
        } finally {
          session.running = null;
          if (envController === controller) envController = null;
        }
      })();
      track(run.catch(() => {}));
      try {
        await run;
      } catch (error) {
        if (controller.signal.aborted) failWith('Setup step was cancelled', 'agent_cancelled');
        throw error;
      }
      return envView();
    }),
  );

  // Copies the plan's verification scripts into workspace.json, for the
  // kinds the user ticked. Lines are rebuilt here, as in envRunStep.
  ipcMain.handle(
    CHANNELS.envApply,
    wrap(async (_event, kinds): Promise<ipc.EnvApplyResult> => {
      const plan = requireEnvPlan();
      if (!Array.isArray(kinds) || kinds.some((kind) => !envSetup.SCRIPT_KINDS.includes(kind))) {
        failWith('kinds must be a list of test, lint or build', 'invalid_argument');
      }
      const config = getConfig();
      // workspace.save() normalizes the checks, filling in what is left unset.
      const checks: Record<string, unknown> = { ...config.checks };
      for (const kind of new Set(kinds as ipc.ScriptKind[])) {
        const name = plan.scripts[kind];
        if (!name) failWith(`The plan has no ${kind} script`, 'invalid_argument');
        // A new command keeps the slot's stage and blocking choice; its report
        // format resets, since the old one described a different command.
        const kept = config.checks[kind];
        checks[kind] = { ...envSetup.scriptCommand(name), stage: kept?.stage, blocking: kept?.blocking };
      }
      setConfig(await repositories.saveConfig(workspace.normalize({ ...config, checks })));
      return envView();
    }),
  );

  ipcMain.handle(
    CHANNELS.envCancel,
    wrap((): boolean => {
      if (!envController) return false;
      envController.abort();
      return true;
    }),
  );

  // Release Manager: proposes a version, notes and a checklist. TaskPilot
  // never tags, commits or pushes; release:write-notes is the only write.

  let releaseController: AbortController | null = null;
  const RECENT_COMMITS = 30;
  const MAX_RELEASE_PACKAGES = 50;
  const MAX_PACKAGE_TEXT = 500;

  const requireReleases = () => {
    if (!releases) return failWith('Releases are unavailable', 'unsupported');
    return releases;
  };

  const NO_START: ipc.ReleaseStartPoint = { kind: 'none', commit: null, label: null, commitCount: 0, commitsTruncated: false, packageCount: 0 };

  // The last finished release's end commit while it is still in HEAD's
  // history, else the newest tag reachable from HEAD, else none.
  const findStart = async (root: string, store: ReleaseStore) => {
    const head = await git.resolveCommit(root, 'HEAD');
    if (!head) return null;
    const latest = store.latest();
    if (latest && (await git.isAncestor(root, latest.endCommit, head)))
      return { head, kind: 'release' as const, commit: latest.endCommit, label: latest.version };
    const tag = await git.latestTag(root);
    return tag ? { head, kind: 'tag' as const, commit: tag.commit, label: tag.name } : null;
  };

  // The start point plus a cheap preview: a capped rev-list count and the
  // package filter a run would use.
  const releaseStartPoint = async (root: string, store: ReleaseStore): Promise<ipc.ReleaseStartPoint> => {
    const found = await findStart(root, store);
    if (!found) return NO_START;
    const counted = await git.countRange(root, found.commit, found.head, { limit: RELEASE_MAX_COMMITS + 1 });
    return {
      kind: found.kind,
      commit: found.commit,
      label: found.label,
      commitCount: Math.min(counted, RELEASE_MAX_COMMITS),
      commitsTruncated: counted > RELEASE_MAX_COMMITS,
      packageCount: unreleasedPackages(store).length,
    };
  };

  const releaseState = async (): Promise<ipc.ReleaseState> => {
    const store = requireReleases();
    const root = getConfig().root;
    return {
      configured: Boolean(root),
      draft: store.draft(),
      history: store.history(),
      startPoint: root ? await releaseStartPoint(root, store) : null,
      running: releaseController !== null,
    };
  };

  // Done packages no earlier release included, with the text the notes are
  // written from. Recorded per release, so this does not depend on the
  // activity log's retention window.
  const unreleasedPackages = (store: ReleaseStore): ReleasePackage[] => {
    const state = workPackages.all();
    return tasks
      .listTasks()
      .filter((task) => state[task.id]?.status === 'done' && !store.isReleased(task.id))
      .slice(0, MAX_RELEASE_PACKAGES)
      .map((task) => {
        const effective = workPackages.effective(task);
        return {
          id: task.id,
          title: effective.title,
          description: effective.description.slice(0, MAX_PACKAGE_TEXT),
          acceptance: effective.acceptance.map((criterion) => criterion.text.slice(0, MAX_PACKAGE_TEXT)),
        };
      });
  };

  ipcMain.handle(
    CHANNELS.releaseGet,
    wrap((): Promise<ipc.ReleaseState> => releaseState()),
  );

  ipcMain.handle(
    CHANNELS.releaseRecentCommits,
    wrap(async (): Promise<ipc.ReleaseCommit[]> => {
      requireReleases();
      return git.recentCommits(requireRoot(), { limit: RECENT_COMMITS });
    }),
  );

  // Starts Release Manager in the background; the renderer polls release:get.
  // A start commit from the renderer is only taken when it is the computed
  // start point or one of the recent commits, so it cannot name arbitrary refs.
  ipcMain.handle(
    CHANNELS.releaseGenerate,
    wrap(async (_event, rawStart): Promise<ipc.ReleaseState> => {
      const store = requireReleases();
      const root = requireRoot();
      const releaseRunner = runnerFor('release-manager');
      if (releaseController) failWith('Release Manager is already running', 'release_busy');
      const endCommit = await git.resolveCommit(root, 'HEAD');
      if (!endCommit) return failWith('The repository has no commits', 'release_no_changes');
      const point = await findStart(root, store);
      let startCommit = point?.commit ?? null;
      let startLabel = point?.label ?? null;
      if (rawStart !== undefined && rawStart !== null) {
        const requested = requireString(rawStart, 'startCommit');
        if (requested !== startCommit) {
          const recent = (await git.recentCommits(root, { limit: RECENT_COMMITS })).find((commit) => commit.sha === requested);
          if (!recent) return failWith('Pick the start point or one of the recent commits', 'release_bad_start', 'startCommit');
          startCommit = recent.sha;
          startLabel = `${recent.sha.slice(0, 7)} ${recent.subject}`;
        }
      }
      if (!startCommit || !startLabel) return failWith('There is no previous release or tag; pick a start commit', 'release_no_start', 'startCommit');
      if (startCommit === endCommit) failWith('There are no commits since the start point', 'release_no_changes');

      const packages = unreleasedPackages(store);
      await store.begin({ startCommit, endCommit });
      const controller = new AbortController();
      releaseController = controller;
      const { path: envPath } = await commandPath();
      const fixedStart = startCommit;
      const fixedLabel = startLabel;
      track(
        (async () => {
          let outcome: { result: Awaited<ReturnType<typeof planRelease>> } | { error: unknown };
          try {
            const result = await planRelease({
              root,
              startCommit: fixedStart,
              startLabel: fixedLabel,
              endCommit,
              packages,
              runAgent: releaseRunner,
              envPath,
              signal: controller.signal,
            });
            throwIfCancelled(controller.signal);
            outcome = { result };
          } catch (error) {
            outcome = { error: controller.signal.aborted ? Object.assign(new Error('Release Manager was cancelled'), { code: 'agent_cancelled' }) : error };
          }
          // Drop the run first, so nobody sees a settled draft that still looks cancellable.
          if (releaseController === controller) releaseController = null;
          if ('error' in outcome) {
            await store.failRun(asAgentError(outcome.error)).catch((error) => console.error('[release] failRun failed', error));
            return;
          }
          const { input, plan, costUsd } = outcome.result;
          recordCost('release-manager', costUsd);
          const summary: ipc.ReleaseInputSummary = {
            commitCount: input.commits.length,
            commitsTruncated: input.commitsTruncated,
            fileCount: input.files.length,
            filesTruncated: input.filesTruncated,
            packageIds: input.packages.map((item) => item.id),
          };
          await store
            .complete(plan, summary, costUsd)
            .catch((error) => store.failRun(asAgentError(error)).catch((failure) => console.error('[release] failRun failed', failure)));
        })(),
      );
      return releaseState();
    }),
  );

  // The store validates the notes length and the checklist indices.
  ipcMain.handle(
    CHANNELS.releaseUpdateDraft,
    wrap(async (_event, raw): Promise<ipc.ReleaseState> => {
      await requireReleases().update(raw);
      return releaseState();
    }),
  );

  // The store refuses while any checklist item is unticked.
  ipcMain.handle(
    CHANNELS.releaseFinish,
    wrap(async (): Promise<ipc.Release> => {
      const store = requireReleases();
      const draft = store.draft();
      const release = await store.finish({ packageIds: draft?.input?.packageIds ?? [] });
      record({ kind: 'release_finished', version: release.version, packageCount: release.packageIds.length });
      return release;
    }),
  );

  // Writes the notes into a Markdown file in the workspace: the ready draft's,
  // or else the latest finished release's. The path must be a relative .md
  // path inside the root, outside .git, not secret-looking, in an existing
  // directory that does not resolve outside the root through a symlink.
  // Nothing is staged or committed.
  ipcMain.handle(
    CHANNELS.releaseWriteNotes,
    wrap(async (_event, raw): Promise<ipc.ReleaseWriteResult> => {
      const store = requireReleases();
      const root = requireRoot();
      const requested = requireString((raw as { path?: unknown } | null | undefined)?.path, 'path').trim();
      if (path.isAbsolute(requested) || path.win32.isAbsolute(requested)) failWith('Use a path relative to the workspace', 'path_not_relative', 'path');
      if (!workspace.isInside(root, requested)) failWith(`Path is outside the workspace: ${requested}`, 'path_outside_workspace', 'path');
      const relative = path.relative(root, path.resolve(root, requested)).split(path.sep).join('/');
      if (!relative.toLowerCase().endsWith('.md')) failWith('Release notes go in a .md file', 'path_not_markdown', 'path');
      if (relative.split('/').some((segment) => segment.toLowerCase() === '.git')) failWith('Paths inside .git are refused', 'path_in_git', 'path');
      if (looksSecret(relative)) failWith('That path looks like it holds secrets', 'path_secret', 'path');

      const draft = store.draft();
      const latest = store.latest();
      const source =
        draft?.status === 'ready' && draft.plan
          ? { version: draft.plan.nextVersion, notes: draft.notesText }
          : latest
            ? { version: latest.version, notes: latest.notesText }
            : null;
      if (!source || !source.notes.trim()) return failWith('There are no release notes to write', 'invalid_state');

      const target = path.join(root, relative);
      let realParent: string;
      try {
        realParent = await fs.realpath(path.dirname(target));
      } catch {
        return failWith(`Directory not found: ${path.posix.dirname(relative)}`, 'invalid_argument', 'path');
      }
      const realRoot = await fs.realpath(root);
      if (realParent !== realRoot && !workspace.isInside(realRoot, realParent))
        failWith('The path leaves the workspace through a link', 'path_outside_workspace', 'path');
      const existing = await fs.lstat(target).catch(() => null);
      if (existing && !existing.isFile()) failWith('The path is not a regular file', 'invalid_argument', 'path');

      const previous = existing ? await fs.readFile(target, 'utf8') : '';
      const day = businessDay(new Date(), appEnv.businessTimeZone);
      const entry = `## ${source.version} — ${day}\n\n${source.notes.trim()}\n`;
      await fs.writeFile(target, previous ? `${entry}\n${previous}` : entry);
      return { path: relative };
    }),
  );

  ipcMain.handle(
    CHANNELS.releaseCancel,
    wrap((): boolean => {
      if (!releaseController) return false;
      releaseController.abort();
      return true;
    }),
  );

  // Committing a finished package (src/main/git_commit.ts)

  // Only once the work is accepted: committing earlier would put unreviewed
  // code in history, and claiming the next package wants a clean tree.
  const COMMITTABLE: ipc.WorkPackageStatus[] = ['accepting', 'done'];

  const requireCommittable = (id: string) => {
    const task = requireTask(id);
    if (!COMMITTABLE.includes(store.get(id).status)) failWith('Only an accepted package can be committed', 'invalid_state');
    return task;
  };

  // The package title as the subject (git's 72-column habit), its id below.
  const suggestedMessage = (task: TaskDefinition) => {
    const subject = task.title.length > gitCommit.MAX_SUBJECT ? `${task.title.slice(0, gitCommit.MAX_SUBJECT - 1)}…` : task.title;
    return `${subject}\n\nTaskPilot 工作包 ${task.id}`;
  };

  ipcMain.handle(
    CHANNELS.commitPreview,
    wrap(async (_event, rawId): Promise<ipc.CommitPreview> => {
      const task = requireCommittable(requireString(rawId, 'id'));
      const { committable, skipped } = await gitCommit.preview(requireRoot(), task.fileScope);
      return { files: committable, skipped, message: suggestedMessage(task) };
    }),
  );

  ipcMain.handle(
    CHANNELS.commitCreate,
    wrap(async (_event, rawId, rawMessage, rawFiles): Promise<ipc.CommitResult> => {
      const task = requireCommittable(requireString(rawId, 'id'));
      const message = gitCommit.validateMessage(rawMessage);
      if (!Array.isArray(rawFiles) || rawFiles.some((file) => typeof file !== 'string')) failWith('files must be a list of paths', 'invalid_argument');
      const files = rawFiles as string[];
      const commit = await gitCommit.commitPaths(requireRoot(), task.fileScope, files, message);
      console.debug(`[commit] package=${task.id} files=${files.length} commit=${commit.slice(0, 8)}`);
      return { commit, files };
    }),
  );

  // Tutor (src/main/agents/tutor.ts): one step explained, on request.

  // One in-flight answer per package step; failures are kept until retried.
  const tutorRuns = new Map<string, AbortController>();
  const tutorFailures = new Map<string, ipc.ErrorInfo>();
  const tutorKey = (id: string, stepIndex: number) => `${id}#${stepIndex}`;

  const requireTutor = () => {
    if (!tutor) return failWith('Tutor is unavailable', 'unsupported');
    return tutor;
  };

  const requireStep = (rawId: unknown, rawIndex: unknown) => {
    const task = requireTask(requireString(rawId, 'id'));
    if (!Number.isInteger(rawIndex) || (rawIndex as number) < 0 || (rawIndex as number) >= task.steps.length) {
      failWith('stepIndex is not a step of this package', 'invalid_step');
    }
    return { task, stepIndex: rawIndex as number, step: task.steps[rawIndex as number] };
  };

  const tutorState = (id: string, stepIndex: number, step: string): ipc.TutorState => {
    const key = tutorKey(id, stepIndex);
    if (tutorRuns.has(key)) return { status: 'running', answer: null, error: null, costUsd: 0 };
    const saved = requireTutor().get(id, stepIndex, step);
    if (saved) return { status: 'done', answer: saved.answer, error: null, costUsd: saved.costUsd };
    const error = tutorFailures.get(key);
    return error ? { status: 'failed', answer: null, error, costUsd: 0 } : { status: 'idle', answer: null, error: null, costUsd: 0 };
  };

  ipcMain.handle(
    CHANNELS.tutorGet,
    wrap((_event, rawId, rawIndex): ipc.TutorState => {
      const { task, stepIndex, step } = requireStep(rawId, rawIndex);
      return tutorState(task.id, stepIndex, step);
    }),
  );

  // A saved answer is returned as is: asking again costs nothing.
  ipcMain.handle(
    CHANNELS.tutorAsk,
    wrap(async (_event, rawId, rawIndex): Promise<ipc.TutorState> => {
      const store = requireTutor();
      const { task, stepIndex, step } = requireStep(rawId, rawIndex);
      const tutorRunner = runnerFor('tutor');
      const key = tutorKey(task.id, stepIndex);
      const current = tutorState(task.id, stepIndex, step);
      if (current.status === 'running' || current.status === 'done') return current;
      // Fixed at the start, like the other runs.
      const { root } = getConfig();
      const controller = new AbortController();
      tutorRuns.set(key, controller);
      tutorFailures.delete(key);
      const { path: envPath } = await commandPath();
      console.debug(`[tutor] ask package=${task.id} step=${stepIndex}`);
      track(
        (async () => {
          try {
            // Scope files as committed; ones the step creates are missing.
            const read = root ? await readTracked(root, task.fileScope.slice(0, tutorAgent.MAX_TUTOR_FILES)) : { files: [], skipped: [] };
            const missing = read.skipped.filter((item) => item.reason === 'not_tracked').map((item) => item.path);
            throwIfCancelled(controller.signal);
            const { output, costUsd } = await tutorRunner({
              prompt: tutorAgent.tutorPrompt({ task, stepIndex, sources: read.files, missing }),
              systemPrompt: tutorAgent.SYSTEM_PROMPT,
              schema: tutorAgent.TUTOR_SCHEMA,
              envPath,
              signal: controller.signal,
            });
            throwIfCancelled(controller.signal);
            const answer = tutorAgent.validateAnswer(output);
            await store.put({ packageId: task.id, stepIndex, step, answer, costUsd: costUsd ?? 0, createdAt: new Date().toISOString() });
          } catch (error) {
            const cancelled = controller.signal.aborted;
            if (!cancelled) console.error('[tutor] run failed', error);
            const info = asAgentError(error);
            tutorFailures.set(
              key,
              cancelled ? { code: 'agent_cancelled', message: 'Tutor was cancelled' } : { code: info.code ?? 'agent_failed', message: info.message },
            );
          } finally {
            tutorRuns.delete(key);
          }
        })(),
      );
      return tutorState(task.id, stepIndex, step);
    }),
  );

  ipcMain.handle(
    CHANNELS.tutorCancel,
    wrap((_event, rawId, rawIndex): boolean => {
      const { task, stepIndex } = requireStep(rawId, rawIndex);
      const controller = tutorRuns.get(tutorKey(task.id, stepIndex));
      controller?.abort();
      return Boolean(controller);
    }),
  );

  // Repositories

  // What a switch would cancel, named for the confirmation dialog.
  const busyRuns = (): ipc.BusyRun[] => {
    const packageTitle = (id: string) => tasks.getTask(id)?.title ?? id;
    return [
      ...[...runs.keys()].map((id): ipc.BusyRun => ({ kind: 'requirement', label: requirements?.get(id).title || id })),
      ...[...reviews.keys()].map((id): ipc.BusyRun => ({ kind: 'review', label: packageTitle(id) })),
      ...[...adjudications.keys()].map((id): ipc.BusyRun => ({ kind: 'adjudication', label: packageTitle(id) })),
      ...[...baselineRuns.keys()].map((id): ipc.BusyRun => ({ kind: 'baseline', label: packageTitle(id) })),
      ...(releaseController ? [{ kind: 'release', label: '发布说明' } as ipc.BusyRun] : []),
      ...(envController ? [{ kind: 'environment', label: '环境初始化' } as ipc.BusyRun] : []),
      ...[...tutorRuns.keys()].map((key): ipc.BusyRun => ({ kind: 'tutor', label: packageTitle(key.split('#')[0]) })),
      ...[...codingRuns.keys()].map((id): ipc.BusyRun => ({ kind: 'coding', label: packageTitle(id) })),
      ...[...codingVerifications.keys()].map((id): ipc.BusyRun => ({ kind: 'coding', label: packageTitle(id) })),
    ];
  };

  // Cancels every background run and waits for its final write, so nothing
  // lands in the next repository's stores.
  const cancelAll = async () => {
    envController?.abort();
    releaseController?.abort();
    for (const controller of baselineRuns.values()) controller.abort();
    for (const controller of runs.values()) controller.abort();
    for (const controller of reviews.values()) controller.abort();
    for (const controller of adjudications.values()) controller.abort();
    for (const runtime of codingRuns.values()) runtime.controller.abort();
    for (const controller of codingVerifications.values()) controller.abort();
    await Promise.allSettled([...pendingRuns]);
    tutorFailures.clear();
  };

  const repositoryList = async (): Promise<ipc.RepositoryList> => {
    const current = repositories.current?.id ?? null;
    const entries = repositories.list();
    const present = await Promise.all(entries.map((entry) => git.isRepo(entry.root).catch(() => false)));
    return {
      current,
      repositories: entries.map((entry: RepositoryEntry, index) => ({
        id: entry.id,
        root: entry.root,
        name: path.basename(entry.root),
        lastOpenedAt: entry.lastOpenedAt,
        current: entry.id === current,
        missing: !present[index],
      })),
    };
  };

  // [人工决策-2026-10-07 14:31:37] 切换仓库时有后台任务：渲染层先弹窗列出、用户确认后，这里取消全部任务再切；内存里同时只有一个仓库的数据。
  // Order matters: the generated package list must be in place before the
  // work package store loads, or saved progress is dropped as unknown ids.
  const openRepository = async (id: string) => {
    await cancelAll();
    await Promise.all([store.flush(), requirements?.flush(), releases?.flush(), activity?.flush(), tutor?.flush()]);
    await repositories.open(id);
    const dir = repositories.dataDir();
    setConfig(await repositories.loadConfig());
    if (requirements) {
      await requirements.open(dir);
      tasks.setGeneratedTasks(requirements.publishedPackages());
    }
    await store.open(dir, tasks.listTasks());
    await releases?.open(dir);
    await activity?.open(dir);
    await tutor?.open(dir);
    activity?.prune().catch((error) => console.error('[activity] prune failed', error));
    // The steward's plan described the previous repository's toolchain.
    env = { ...env, root: null, status: 'idle', facts: null, blockers: [], plan: null, error: null, costUsd: 0, results: {}, running: null };
    console.debug(`[repositories] switched id=${id} packages=${tasks.listTasks().length}`);
  };

  ipcMain.handle(
    CHANNELS.repositoriesList,
    wrap(() => repositoryList()),
  );

  ipcMain.handle(
    CHANNELS.repositoriesBusy,
    wrap((): ipc.BusyRun[] => busyRuns()),
  );

  ipcMain.handle(
    CHANNELS.repositoriesAdd,
    wrap(async (_event, rawRoot, open): Promise<ipc.RepositoryList> => {
      const { root } = await validateRoot(rawRoot);
      const hadCurrent = repositories.current !== null;
      const entry = await repositories.add(root);
      // The first repository adopts the unassigned data, which is what is loaded.
      if (!hadCurrent || open === true) await openRepository(entry.id);
      return repositoryList();
    }),
  );

  ipcMain.handle(
    CHANNELS.repositoriesSwitch,
    wrap(async (_event, rawId): Promise<ipc.RepositoryList> => {
      const id = requireString(rawId, 'id');
      if (!repositories.get(id)) return failWith(`Unknown repository: ${id}`, 'unknown_repository');
      if (repositories.current?.id !== id) await openRepository(id);
      return repositoryList();
    }),
  );

  ipcMain.handle(
    CHANNELS.repositoriesRelocate,
    wrap(async (_event, rawId, rawRoot): Promise<ipc.RepositoryList> => {
      const id = requireString(rawId, 'id');
      const { root } = await validateRoot(rawRoot);
      await repositories.relocate(id, root);
      if (repositories.current?.id === id) setConfig({ ...getConfig(), root });
      return repositoryList();
    }),
  );

  return {
    // Cancels running agents and waits for their final writes.
    shutdown: cancelAll,
  };
};
