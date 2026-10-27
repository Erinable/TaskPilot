// What the main process's domains share: the stores, the loaded config and
// preferences, the background run registry, activity recording and the
// package lookups every domain needs. Built once by ipc.ts; nothing here
// knows about IPC.
import fs from 'node:fs/promises';
import path from 'node:path';

import { codedError, failWith, requireString } from './coded_error.ts';
import * as tasks from './tasks.ts';
import * as git from './git.ts';
import * as preferences from './preferences.ts';
import * as claudeCli from './agents/claude_cli.ts';
import * as cliRunner from './agents/cli_runner.ts';
import * as cliSignIn from './cli_sign_in.ts';
import { createPathResolver } from './shell_env.ts';
import { readModelCatalog } from './agent_model_catalog.ts';
import { BackgroundRuns } from './background_runs.ts';
import * as effectiveSteps from './effective_steps.ts';
import * as projectConfig from './project_config.ts';
import * as courses from './courses.ts';
import { PRESET_IDS } from './presets/index.ts';
import { WorkspaceError } from './command_line.ts';
import { buildProfile } from './project_profile.ts';
import { humanTransitions } from './work_package_store.ts';
import { TRANSITIONS, label } from './work_package_status.ts';
import { supportsAgentConfig } from '../shared/agent_runtime.ts';
import type { AgentId } from '../shared/agent_runtime.ts';
import type * as activityTypes from '../shared/ipc/activity.ts';
import type * as packageTypes from '../shared/ipc/packages.ts';
import type * as requirementTypes from '../shared/ipc/requirements.ts';
import type * as workspace from './workspace.ts';
import type { ProjectProfile } from '../shared/project_profile.ts';
import type { ActivityLog, LoggedEvent } from './activity_log.ts';
import type { WorkPackageStore } from './work_package_store.ts';
import type { Requirement, RequirementStore } from './requirement_store.ts';
import type { ReleaseStore } from './release_store.ts';
import type { TutorStore } from './tutor_store.ts';
import type { NoteStore } from './note_store.ts';
import type { RepositoryRegistry } from './repositories.ts';
import type { TaskDefinition } from './tasks.ts';

type RunAgent = claudeCli.RunAgent;

// The operating system's dialogs and shell; each is unavailable when left out.
export type ShellDeps = {
  pickDirectory?: (defaultPath: string | null) => Promise<string | null>;
  // Picks one file of the given extensions; null when cancelled.
  pickFile?: (defaultPath: string | null, filters: { name: string; extensions: string[] }[]) => Promise<string | null>;
  // Opens a folder in the OS.
  revealPath?: (dir: string) => Promise<void>;
  // Shows a workspace file in the OS file manager (shell.showItemInFolder).
  revealFile?: (file: string) => void;
  // Opens a link from a note in the default browser or mail app.
  openUrl?: (url: string) => Promise<void>;
  // Replaces how open_file.ts starts the editor (tests).
  launchEditor?: (file: string, args: string[]) => Promise<void>;
};

// The analysis agents' CLIs; injectable so tests never run a real CLI.
export type AgentDeps = {
  // Replaces claude-cli.runStructured (tests).
  runAgent?: RunAgent;
  probeAgent?: typeof cliRunner.probeCli;
  // Offline sign-in check for a CLI.
  checkSignIn?: typeof cliSignIn.checkSignIn;
  modelCatalog?: typeof readModelCatalog;
};

export type AppDeps = {
  store: WorkPackageStore;
  // userData: preferences and the repository registry live here.
  configDir: string;
  // The course packs that ship with TaskPilot, read at startup.
  builtinCourses: courses.BuiltinCourses;
  // Known repositories; each keeps its own data directory.
  repositories: RepositoryRegistry;
  // In-memory accessors for the loaded config.
  getConfig: () => workspace.WorkspaceConfig;
  setConfig: (config: workspace.WorkspaceConfig) => void;
  // In-memory accessors for preferences.
  getPreferences?: () => preferences.Preferences;
  setPreferences?: (prefs: preferences.Preferences) => void;
  // From shell_env.createPathResolver().
  pathResolver?: ReturnType<typeof createPathResolver>;
  // E.g. to apply the theme to native windows.
  onPreferencesChanged?: (next: preferences.Preferences, previous: preferences.Preferences) => void;
  // Shown on the environment page.
  appVersion?: string;
  // Enables the requirement flow.
  requirements?: RequirementStore | null;
  // Called after generated packages are added to the queue.
  onPackagesPublished?: (definitions: TaskDefinition[]) => void;
  // Records state changes for metrics and the activity feed.
  activity?: ActivityLog | null;
  // Enables Release Manager.
  releases?: ReleaseStore | null;
  // Enables Tutor.
  tutor?: TutorStore | null;
  // Learning notes; global, not per repository.
  notes?: NoteStore | null;
  shell?: ShellDeps;
  agents?: AgentDeps;
};

// The work package store's state for one package.
export type PackageState = ReturnType<WorkPackageStore['get']>;

// The stores type some persisted fields more loosely than the wire contract
// (QA's report and diff as unknown, reason codes as strings). These casts are
// the one place their state becomes the contract.
export const toWireState = (state: PackageState) => state as packageTypes.WorkPackageState;
export const toWireRequirement = (item: Requirement) => item as requirementTypes.Requirement;

// `task` is the effective definition (WorkPackageStore.effective()).
// `dependencies` comes from the caller, which can see the other packages.
export const buildTaskView = (task: TaskDefinition, packageState: PackageState, dependencies: packageTypes.PackageDependency[] = []): packageTypes.TaskView => {
  const state = toWireState(packageState);
  return {
    ...task,
    dependencies,
    completedAt: packageState.completedAt ?? null,
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
    mode: state.mode ?? null,
    referenceRun: state.referenceRun ?? null,
    grade: state.grade ?? null,
    revision: state.revision && {
      version: state.revision.version,
      reason: state.revision.reason,
      changes: state.revision.changes,
      revisedAt: state.revision.revisedAt,
    },
    // Filtered to the human actor, so only human transitions remain.
    humanTransitions: humanTransitions(packageState) as packageTypes.HumanTransition[],
  };
};

// The agent transition that moved a package from `from` to `to`; the store
// picks it, so it is looked up rather than passed back.
export const agentTransitionOf = (from: packageTypes.WorkPackageStatus, to: packageTypes.WorkPackageStatus) =>
  TRANSITIONS.find((transition) => transition.actor === 'agent' && transition.from === from && transition.to === to)?.name as packageTypes.AgentTransition;

export const createAppContext = (deps: AppDeps) => {
  const {
    store,
    configDir,
    builtinCourses,
    repositories,
    getConfig,
    setConfig,
    getPreferences = () => preferences.defaults(),
    setPreferences = () => {},
    pathResolver = createPathResolver(),
    onPreferencesChanged,
    appVersion,
    requirements = null,
    onPackagesPublished,
    activity = null,
    releases = null,
    tutor = null,
    notes = null,
    shell = {},
  } = deps;
  const { runAgent, probeAgent = cliRunner.probeCli, checkSignIn = cliSignIn.checkSignIn, modelCatalog = readModelCatalog } = deps.agents ?? {};
  // Published package definitions; without requirements nothing is published.
  const catalog: tasks.TaskCatalog = requirements ?? tasks.EMPTY_CATALOG;

  // The PATH verification commands run with, per the user's preference.
  const commandPath = () => pathResolver.resolve(getPreferences().environment.pathSource);

  // The steps the open repository runs: preset, taskpilot.toml and this
  // machine's settings merged. Read fresh each time, so an edit to the file
  // shows up on the next run without a restart.
  const resolveSteps = async (config: workspace.WorkspaceConfig = getConfig(), options?: Parameters<typeof effectiveSteps.resolve>[1]) =>
    effectiveSteps.resolve(config, { envPath: (await commandPath()).path, ...options });
  const runnableSteps = async (config: workspace.WorkspaceConfig = getConfig()) => effectiveSteps.runnable(await resolveSteps(config));

  // What the agents are told about the open repository; null without one,
  // or when it cannot be built (an agent then plans as before). Cached until
  // the root, taskpilot.toml's mtime, this machine's steps or the PATH
  // change, so a prompt does not re-read the repository every time.
  let cachedProfile: { key: string; profile: Promise<ProjectProfile | null> } | null = null;
  const profile = async (config: workspace.WorkspaceConfig = getConfig()): Promise<ProjectProfile | null> => {
    if (!config.root) return null;
    const mtime = await fs.stat(path.join(config.root, projectConfig.PROJECT_FILENAME)).then(
      (stat) => stat.mtimeMs,
      () => null,
    );
    const envPath = (await commandPath()).path;
    const key = JSON.stringify([config.root, mtime, config.steps, envPath]);
    if (cachedProfile?.key !== key) {
      const built = resolveSteps(config)
        .then(buildProfile)
        .catch((error) => {
          console.error('[profile] build failed', error);
          if (cachedProfile?.key === key) cachedProfile = null;
          return null;
        });
      cachedProfile = { key, profile: built };
    }
    return cachedProfile.profile;
  };

  // Where course packs and their confirmations live for `config`'s repository.
  const coursePlaces = (config: workspace.WorkspaceConfig = getConfig()): courses.CoursePlaces => ({
    root: config.root,
    dataDir: repositories.dataDir(),
    configDir,
    builtin: builtinCourses,
  });

  // The course pack the open repository teaches with (./courses.ts). Read
  // fresh each time, like the steps. A broken taskpilot.toml names no pack;
  // the steps report its error.
  const course = async (config: workspace.WorkspaceConfig = getConfig()) => {
    let project: string | null = null;
    if (config.root) {
      try {
        const text = await projectConfig.readProjectText(config.root);
        if (text !== null) project = projectConfig.parseProject(text, PRESET_IDS).course;
      } catch (error) {
        if (!(error instanceof WorkspaceError)) throw error;
      }
    }
    return courses.resolveCourse(coursePlaces(config), { local: config.course, project });
  };

  // Activity is a side record: a failed append is logged and never fails the
  // action that caused it.
  const record = (event: LoggedEvent) => {
    activity?.append(event).catch((error) => console.error('[activity] append failed', error));
  };

  // One model call's spend and usage, for the cost page and the team page's
  // weekly total. Every call is kept, priced or not, so unknown spend is
  // counted rather than silently missing.
  const recordCall = (agent: AgentId, call: activityTypes.ModelCall, subject: activityTypes.CostSubject) =>
    record({ kind: 'agent_cost', agent, costUsd: call.costUsd, call, subject });

  // Freeze a role's runtime at the start of its background action. Saving the
  // next settings must not change an Architect step halfway through a run.
  // Each model call is recorded here, so agents never handle cost themselves.
  const runnerFor = (agent: Exclude<AgentId, 'coding-agent'>, subject: activityTypes.CostSubject = null): RunAgent => {
    const config = { ...getPreferences().agents[agent] };
    return async (options) => {
      if (!supportsAgentConfig(agent, config)) throw codedError('The selected CLI cannot safely run this analysis agent', 'agent_unavailable');
      let result: claudeCli.StructuredResult;
      try {
        result = runAgent
          ? await runAgent({ ...options, command: config.cli, model: config.model || null, thinking: config.thinking })
          : await cliRunner.runStructured(options, config);
      } catch (error) {
        // A failed, timed-out or cancelled call can still have been billed;
        // whatever the CLI reported for it is recorded like a success.
        if (error instanceof claudeCli.AgentRunError)
          for (const call of [...error.spentBefore, ...(error.call ? [error.call] : [])]) recordCall(agent, call, subject);
        throw error;
      }
      for (const call of result.spentBefore ?? []) recordCall(agent, call, subject);
      recordCall(agent, result.call ?? { cli: config.cli, provider: null, model: config.model || null, costUsd: result.costUsd, tokens: null }, subject);
      return result;
    };
  };

  // Parses and checks a root the user picked. It must be an absolute path to
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

  const requireRoot = () => {
    const { root } = getConfig();
    if (!root) throw codedError('No workspace root is configured', 'no_workspace');
    return root;
  };

  const requireBaseline = (id: string) => {
    const state = store.get(id);
    if (!state.baseline) throw codedError('Work package has no baseline; claim it first', 'no_baseline');
    return state.baseline;
  };

  // The definition as currently planned, including Architect's replans.
  const effectiveTask = (id: string) => {
    const task = catalog.getTask(id);
    return task ? store.effective(task) : null;
  };

  const requireTask = (id: string) => {
    const task = effectiveTask(id);
    if (!task) throw codedError(`Unknown work package: ${id}`, 'unknown_package');
    return task;
  };

  // Records a package moving between statuses.
  const recordTransition = (
    id: string,
    before: packageTypes.WorkPackageStatus,
    after: { status: packageTypes.WorkPackageStatus },
    transition: packageTypes.HumanTransition | packageTypes.AgentTransition | packageTypes.CodingTransition,
    actor: 'human' | 'agent' | 'coding-agent',
  ) => {
    if (before === after.status) return;
    record({ kind: 'package_transition', packageId: id, title: catalog.getTask(id)?.title ?? id, transition, actor, from: before, to: after.status });
  };

  // Where each of a package's dependencies stands. One blocks claiming
  // until it is done, unless the developer waived it; a dependency whose
  // package no longer exists cannot be finished, so it never blocks.
  const dependenciesOf = (task: TaskDefinition, state: PackageState): packageTypes.PackageDependency[] =>
    (task.dependsOn ?? []).map((id) => {
      const dependency = catalog.getTask(id);
      const status = dependency ? store.get(id).status : null;
      const waived = state.waivedDependencies.includes(id);
      return { id, title: dependency?.title ?? null, status, waived, blocking: Boolean(dependency) && status !== 'done' && !waived };
    });
  // A blocked package does not offer `claim`, so no screen shows a button the guard would refuse.
  const viewOf = (task: TaskDefinition, state: PackageState) => {
    const dependencies = dependenciesOf(task, state);
    const view = buildTaskView(task, state, dependencies);
    return dependencies.some((dependency) => dependency.blocking)
      ? { ...view, humanTransitions: view.humanTransitions.filter((name) => name !== 'claim') }
      : view;
  };

  // The Architect summary of the requirement a package came from, if any.
  const interfacesFor = (task: TaskDefinition) => {
    if (!requirements || !task.requirementId) return null;
    try {
      return requirements.get(task.requirementId).interfaces?.text ?? null;
    } catch {
      return null;
    }
  };

  // A requirement deleted since keeps its id as the title.
  const requirementTitle = (id: string) => {
    try {
      return requirements?.get(id).title || id;
    } catch {
      return id;
    }
  };

  // Every background run and its promise, so a switch, a reset or shutdown
  // (and tests) can cancel them and wait for their writes.
  const backgroundRuns = new BackgroundRuns();
  const packageLabel = (id: string) => () => catalog.getTask(id)?.title ?? id;

  // In-memory leftovers of the runs (a domain's failures, event history)
  // belong to the repository they ran in and are dropped with the runs.
  const leftovers: (() => void)[] = [];
  const onCancelAll = (drop: () => void) => void leftovers.push(drop);
  // Cancels every background run and waits for its final write, so nothing
  // lands in the next repository's stores.
  const cancelAll = async () => {
    await backgroundRuns.cancelAll();
    for (const drop of leftovers) drop();
  };

  // Domain state made for the previous repository, reset after a switch.
  const openedListeners: (() => void)[] = [];
  const onRepositoryOpened = (listener: () => void) => void openedListeners.push(listener);
  const repositoryOpened = () => {
    for (const listener of openedListeners) listener();
  };

  // Waits for every queued store write, including the activity appends
  // that are not awaited where they are recorded.
  const flushStores = () => Promise.all([store.flush(), requirements?.flush(), releases?.flush(), activity?.flush(), tutor?.flush(), notes?.flush()]);

  // [人工决策-2026-10-07 14:31:37] 切换仓库时有后台任务：渲染层先弹窗列出、用户确认后，这里取消全部任务再切；内存里同时只有一个仓库的数据。
  // Order matters: requirements must be open (their published packages are
  // the catalog) before the work package store loads, or saved progress is
  // dropped as unknown ids.
  const openRepository = async (id: string) => {
    await cancelAll();
    await flushStores();
    await repositories.open(id);
    const dir = repositories.dataDir();
    setConfig(await repositories.loadConfig());
    await requirements?.open(dir);
    await store.open(dir, catalog.listTasks());
    await releases?.open(dir);
    await activity?.open(dir);
    await tutor?.open(dir);
    activity?.prune().catch((error) => console.error('[activity] prune failed', error));
    repositoryOpened();
    console.debug(`[repositories] switched id=${id} packages=${catalog.listTasks().length}`);
  };

  return {
    store,
    configDir,
    builtinCourses,
    repositories,
    getConfig,
    setConfig,
    getPreferences,
    setPreferences,
    pathResolver,
    onPreferencesChanged,
    appVersion,
    requirements,
    onPackagesPublished,
    activity,
    releases,
    tutor,
    notes,
    shell,
    probeAgent,
    checkSignIn,
    modelCatalog,
    catalog,
    commandPath,
    resolveSteps,
    runnableSteps,
    profile,
    coursePlaces,
    course,
    record,
    recordCall,
    runnerFor,
    validateRoot,
    requireRoot,
    requireBaseline,
    requireTask,
    recordTransition,
    dependenciesOf,
    viewOf,
    interfacesFor,
    requirementTitle,
    backgroundRuns,
    packageLabel,
    onCancelAll,
    cancelAll,
    onRepositoryOpened,
    repositoryOpened,
    flushStores,
    openRepository,
  };
};

export type AppContext = ReturnType<typeof createAppContext>;
