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
import * as claudeCli from './agents/claude_cli.ts';
import * as productLead from './agents/product_lead.ts';
import * as envSetup from './env_setup.ts';
import * as evidence from './evidence.ts';
import {
  summarizeForRequirement,
  reviewWorkPackage,
  adjudicateDeviation,
  planEnvironment,
  planRelease,
  throwIfCancelled,
  RELEASE_MAX_COMMITS,
} from './agents/pipeline.ts';
import { STATE_FILENAME, humanTransitions } from './work_package_store.ts';
import { TRANSITIONS, label } from './work_package_status.ts';
import type { TransitionName } from './work_package_status.ts';
import { env as appEnv } from './env.ts';
import { CHANNELS } from '../shared/ipc_channels.ts';
import { businessDay, computeMetrics, RETENTION_DAYS } from './activity_log.ts';
import type { ActivityLog } from './activity_log.ts';
import { buildEngineeringMap, MAX_TREE_FILES } from './engineering_map.ts';
import { indexEntries, looksSecret } from './repo_reader.ts';
import type { Channel } from '../shared/ipc_channels.ts';
import type * as ipc from '../shared/ipc_types.ts';
import type { BaselineChecks, BaselineChecksStatus, DeviationInput, WorkPackageStore } from './work_package_store.ts';
import type { Requirement, RequirementStore } from './requirement_store.ts';
import type { EnvFailure } from './agents/env_steward.ts';
import type { ReleaseStore } from './release_store.ts';
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
  // Where workspace.json lives.
  configDir: string;
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
  // Shown on the environment page.
  appVersion?: string;
  // Enables the requirement flow.
  requirements?: RequirementStore | null;
  // Replaces claude-cli.runStructured (tests).
  runAgent?: RunAgent;
  // Called after generated packages are added to the queue.
  onPackagesPublished?: (definitions: TaskDefinition[]) => void;
  // Records state changes for metrics and the activity feed.
  activity?: ActivityLog | null;
  // Enables Release Manager.
  releases?: ReleaseStore | null;
};

export type IpcHandle = { shutdown: () => Promise<void> };

export const registerIpcHandlers = (ipcMain: IpcMainLike, deps: IpcDeps): IpcHandle => {
  const {
    store,
    configDir,
    getConfig,
    setConfig,
    pickDirectory,
    getPreferences = () => preferences.defaults(),
    setPreferences = () => {},
    pathResolver = createPathResolver(),
    onPreferencesChanged,
    revealPath,
    appVersion,
    requirements = null,
    runAgent = claudeCli.runStructured,
    onPackagesPublished,
    activity = null,
    releases = null,
  } = deps;

  // The PATH verification commands run with, per the user's preference.
  const commandPath = () => pathResolver.resolve(getPreferences().environment.pathSource);

  const failWith: (message: string, code: string, field?: string) => never = (message, code, field) => {
    throw codedError(message, code, field);
  };

  // Parses and checks a settings form. The root must be an absolute path to
  // an existing directory inside a git repository; it is then normalized to
  // the repository's top level, because git reports diff paths relative to
  // that and file scopes would otherwise never match.
  const validateForm = async (form: unknown) => {
    const config = workspace.fromForm(form as workspace.WorkspaceFormInput, getConfig());
    const info: { normalizedFrom: string | null; repo: ipc.RepoInfo | null } = { normalizedFrom: null, repo: null };
    if (!config.root) return { config, info };

    if (!path.isAbsolute(config.root)) failWith('Workspace root must be an absolute path', 'root_not_absolute', 'root');
    let stat;
    try {
      stat = await fs.stat(config.root);
    } catch {
      return failWith(`Directory not found: ${config.root}`, 'root_not_found', 'root');
    }
    if (!stat.isDirectory()) failWith(`Not a directory: ${config.root}`, 'root_not_found', 'root');
    if (!(await git.isRepo(config.root))) failWith('Workspace root is not a git repository', 'not_a_repo', 'root');

    const top = await git.topLevel(config.root);
    if (path.resolve(top) !== path.resolve(config.root)) info.normalizedFrom = config.root;
    config.root = top;
    info.repo = await git.describe(top);
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
  const record = (event: ipc.ActivityEvent) => {
    activity?.append(event).catch((error) => console.error('[activity] append failed', error));
  };

  // Records a package moving between statuses.
  const recordTransition = (
    id: string,
    before: ipc.WorkPackageStatus,
    after: { status: ipc.WorkPackageStatus },
    transition: ipc.HumanTransition | ipc.AgentTransition,
    actor: 'human' | 'agent',
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
          runAgent,
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
        await store
          .completeReview(id, outcome.result)
          .then((after) => recordTransition(id, before, after, agentTransitionOf(before, after.status), 'agent'))
          .catch((error) => store.failReview(id, error).catch(() => {}));
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
    const entry = await store.beginAdjudication(id);
    const controller = new AbortController();
    adjudications.set(id, controller);
    const settled = (async () => {
      let outcome: { result: Awaited<ReturnType<typeof adjudicateDeviation>> } | { error: unknown };
      try {
        const { path: envPath } = await commandPath();
        const result = await adjudicateDeviation(task, {
          root: getConfig().root,
          deviations: entry.deviations,
          // beginAdjudication() has just set it.
          mustReplan: entry.adjudication?.mustReplan === true,
          runAgent,
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
      const saved = await workspace.save(configDir, config);
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
      return { root: config.root, normalizedFrom: info.normalizedFrom, repo: info.repo, commands };
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
    wrap((): ipc.DataInfo => ({
      configDir,
      files: [workspace.CONFIG_FILENAME, preferences.PREFERENCES_FILENAME, STATE_FILENAME],
      packages: store.summary(),
    })),
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
  const repositoryFiles = async (): Promise<string[]> => {
    const root = getConfig().root;
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
    const item = await store.begin(id, step);
    const controller = new AbortController();
    runs.set(id, controller);
    const files = await repositoryFiles();
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
            runAgent,
            root: getConfig().root,
            files,
            envPath,
            signal: controller.signal,
          });
          architectCost = result.costUsd;
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
        const { output, costUsd } = await runAgent({
          prompt: buildPrompt({ ...item, files, interfaces }),
          systemPrompt: productLead.SYSTEM_PROMPT,
          schema,
          envPath,
          signal: controller.signal,
        });
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

  // The feed, the week's metrics and who on the team is busy. The metrics
  // read the retention window once; the feed reads only the newest days.
  ipcMain.handle(
    CHANNELS.activityOverview,
    wrap(async (): Promise<ipc.ActivityOverview> => {
      if (!activity) return failWith('Activity is unavailable', 'unsupported');
      const { path: envPath } = await commandPath();
      const [recent, window, executable] = await Promise.all([
        activity.recent({ days: RETENTION_DAYS, limit: 20 }),
        activity.window(RETENTION_DAYS),
        workspace.resolveExecutable('claude', { envPath }),
      ]);
      const busy = new Set<ipc.ActivityAgent>();
      if (reviews.size) busy.add('qa');
      if (adjudications.size) busy.add('architect');
      if (releaseController) busy.add('release-manager');
      for (const id of runs.keys()) {
        busy.add(requirements?.get(id).phase === 'architect' ? 'architect' : 'product-lead');
      }
      return {
        recent,
        metrics: computeMetrics(window, new Date(), activity.timeZone),
        team: { available: Boolean(executable), busy: [...busy] },
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

  // Whether the Claude Code CLI can be found on the command PATH.
  ipcMain.handle(
    CHANNELS.agentStatus,
    wrap(async (): Promise<ipc.AgentStatus> => {
      const { path: envPath } = await commandPath();
      const resolved = await workspace.resolveExecutable('claude', { envPath });
      return { available: Boolean(resolved), command: resolved };
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
            const outcome = await planEnvironment({ root, runAgent, envPath, signal: controller.signal, failure });
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
      setConfig(await workspace.save(configDir, { ...config, checks }));
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
              runAgent,
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

  return {
    // Cancels running agents and waits for their final writes.
    async shutdown() {
      envController?.abort();
      releaseController?.abort();
      for (const controller of baselineRuns.values()) controller.abort();
      for (const controller of runs.values()) controller.abort();
      for (const controller of reviews.values()) controller.abort();
      for (const controller of adjudications.values()) controller.abort();
      await Promise.allSettled([...pendingRuns]);
    },
  };
};
