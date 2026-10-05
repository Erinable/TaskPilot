// The renderer's only route to the filesystem, git and command execution.
// Every handler validates its arguments here: the renderer is treated as
// untrusted input, since the content it displays originates from AI agents.
const fs = require('node:fs/promises');
const path = require('node:path');
const tasks = require('./tasks');
const git = require('./git');
const workspace = require('./workspace');
const verification = require('./verification');
const preferences = require('./preferences');
const { createPathResolver } = require('./shell-env');
const claudeCli = require('./agents/claude-cli');
const productLead = require('./agents/product-lead');
const envSetup = require('./env-setup');
const evidence = require('./evidence');
const { summarizeForRequirement, reviewWorkPackage, adjudicateDeviation, planEnvironment, throwIfCancelled } = require('./agents/pipeline');
const { STATE_FILENAME, humanTransitions } = require('./work-package-store');
const { label } = require('./work-package-status');

const CHANNELS = {
  listTasks: 'tasks:list',
  getTask: 'tasks:get',
  transition: 'package:transition',
  setStepDone: 'package:set-step-done',
  reviewRetry: 'review:retry',
  reviewCancel: 'review:cancel',
  deviationRetry: 'deviation:retry',
  deviationCancel: 'deviation:cancel',
  workspaceGet: 'workspace:get',
  workspaceSet: 'workspace:set',
  workspaceCheck: 'workspace:check',
  workspacePickRoot: 'workspace:pick-root',
  workspaceInfo: 'workspace:info',
  diffStat: 'diff:stat',
  diffFile: 'diff:file',
  verifyRun: 'verify:run',
  preferencesGet: 'preferences:get',
  preferencesSet: 'preferences:set',
  environmentInfo: 'environment:info',
  dataInfo: 'data:info',
  dataResetProgress: 'data:reset-progress',
  dataReveal: 'data:reveal',
  requirementsList: 'requirements:list',
  requirementsGet: 'requirements:get',
  requirementsCreate: 'requirements:create',
  requirementsClarify: 'requirements:clarify',
  requirementsAnswer: 'requirements:answer',
  requirementsPlan: 'requirements:plan',
  requirementsPublish: 'requirements:publish',
  requirementsRemove: 'requirements:remove',
  requirementsCancel: 'requirements:cancel',
  agentStatus: 'agent:status',
  envGet: 'env:get',
  envPlan: 'env:plan',
  envSetAllowScripts: 'env:set-allow-scripts',
  envRunStep: 'env:run-step',
  envApply: 'env:apply',
  envCancel: 'env:cancel',
  baselineMeasure: 'baseline:measure',
};

/** Shaped like an Error but safe to send over IPC. */
function toFailure(error) {
  const failure = { code: error.code ?? 'unknown', message: error.message };
  if (error.field) failure.field = error.field;
  return { ok: false, error: failure };
}

/** Config plus the command lines and check options the settings form edits. */
function toFormView(config) {
  const form = workspace.toForm(config);
  return { root: config.root, commands: config.commands, checks: config.checks, lines: form.commands, options: form.options };
}

/** Checks that run before review, with the line their baselines are keyed by. */
function submitChecks(config) {
  return workspace.COMMAND_KINDS
    .filter((kind) => config.checks?.[kind]?.stage === 'submit')
    .map((kind) => {
      const check = config.checks[kind];
      return { kind, stage: check.stage, blocking: check.blocking, line: checkLine(check) };
    });
}

/** The command line plus whatever else changes what a check measures. */
function checkLine(check) {
  const extras = [];
  if (check.report.format === 'junit') extras.push(`[junit ${check.report.path}]`);
  const env = Object.entries(check.env ?? {}).map(([k, v]) => `${k}=${v}`).sort();
  if (env.length) extras.push(`[env ${env.join(' ')}]`);
  return [workspace.formatCommandLine(check), ...extras].join(' ');
}

/** Report files the checks write are not the package's changes. */
function reportIgnore(config) {
  const paths = new Set(workspace.COMMAND_KINDS
    .map((kind) => config.checks?.[kind])
    .filter((check) => check?.report.format === 'junit')
    .map((check) => check.report.path));
  return (candidate) => paths.has(candidate) || candidate.startsWith('.taskpilot/');
}

function requireString(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    const error = new Error(`${name} must be a non-empty string`);
    error.code = 'invalid_argument';
    throw error;
  }
  return value;
}

/**
 * Wraps a handler so the renderer always receives {ok: true, data} or
 * {ok: false, error} instead of an opaque rejected promise.
 */
function wrap(handler) {
  return async (...args) => {
    try {
      return { ok: true, data: await handler(...args) };
    } catch (error) {
      return toFailure(error);
    }
  };
}

/** `task` is the effective definition (WorkPackageStore.effective()). */
function buildTaskView(task, state) {
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
    revision: state.revision && { version: state.revision.version, reason: state.revision.reason, changes: state.revision.changes, revisedAt: state.revision.revisedAt },
    humanTransitions: humanTransitions(state),
  };
}

/**
 * @param ipcMain Electron's ipcMain (or a stand-in exposing `handle`).
 * @param deps.store WorkPackageStore
 * @param deps.configDir where workspace.json lives
 * @param deps.getConfig/setConfig in-memory accessors for the loaded config
 * @param deps.pickDirectory optional (defaultPath) => Promise<string|null>
 * @param deps.getPreferences/setPreferences in-memory accessors for preferences
 * @param deps.pathResolver from shell-env.createPathResolver()
 * @param deps.onPreferencesChanged optional (next, previous) => void, e.g. to
 *   apply the theme to native windows
 * @param deps.revealPath optional (dir) => Promise, opens a folder in the OS
 * @param deps.appVersion optional, shown on the environment page
 * @param deps.requirements optional RequirementStore; enables the requirement flow
 * @param deps.runAgent optional, replaces claude-cli.runStructured (tests)
 * @param deps.onPackagesPublished optional (definitions) => void, called after
 *   generated packages are added to the queue
 */
function registerIpcHandlers(ipcMain, deps) {
  const {
    store, configDir, getConfig, setConfig, pickDirectory,
    getPreferences = () => preferences.defaults(),
    setPreferences = () => {},
    pathResolver = createPathResolver(),
    onPreferencesChanged, revealPath, appVersion,
    requirements = null,
    runAgent = claudeCli.runStructured,
    onPackagesPublished,
  } = deps;

  /** The PATH verification commands run with, per the user's preference. */
  const commandPath = () => pathResolver.resolve(getPreferences().environment.pathSource);

  const failWith = (message, code, field) => {
    const error = new Error(message);
    error.code = code;
    if (field) error.field = field;
    throw error;
  };

  /**
   * Parses and checks a settings form. The root must be an absolute path to
   * an existing directory inside a git repository; it is then normalized to
   * the repository's top level, because git reports diff paths relative to
   * that and file scopes would otherwise never match.
   */
  const validateForm = async (form) => {
    const config = workspace.fromForm(form, getConfig());
    const info = { normalizedFrom: null, repo: null };
    if (!config.root) return { config, info };

    if (!path.isAbsolute(config.root)) failWith('Workspace root must be an absolute path', 'root_not_absolute', 'root');
    let stat;
    try {
      stat = await fs.stat(config.root);
    } catch {
      failWith(`Directory not found: ${config.root}`, 'root_not_found', 'root');
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
    if (!root) {
      const error = new Error('No workspace root is configured');
      error.code = 'no_workspace';
      throw error;
    }
    return root;
  };

  // Resolves a renderer-supplied path, refusing anything outside the root.
  const safePath = (root, candidate) => {
    requireString(candidate, 'path');
    if (!workspace.isInside(root, candidate)) {
      const error = new Error(`Path is outside the workspace: ${candidate}`);
      error.code = 'path_outside_workspace';
      throw error;
    }
    return candidate;
  };

  const requireBaseline = (id) => {
    const state = store.get(id);
    if (!state.baseline) {
      const error = new Error('Work package has no baseline; claim it first');
      error.code = 'no_baseline';
      throw error;
    }
    return state.baseline;
  };

  /** The definition as currently planned, including Architect's replans. */
  const effectiveTask = (id) => {
    const task = tasks.getTask(id);
    return task ? store.effective(task) : null;
  };

  ipcMain.handle(CHANNELS.listTasks, wrap(() => {
    const state = store.all();
    return tasks.listTasks().map((task) => buildTaskView(store.effective(task), state[task.id]));
  }));

  ipcMain.handle(CHANNELS.getTask, wrap((_event, id) => {
    const task = effectiveTask(requireString(id, 'id'));
    if (!task) {
      const error = new Error(`Unknown work package: ${id}`);
      error.code = 'unknown_package';
      throw error;
    }
    return buildTaskView(task, store.get(id));
  }));

  // Background run promises, so shutdown (and tests) can wait for writes.
  const pendingRuns = new Set();
  const track = (promise) => {
    pendingRuns.add(promise);
    promise.finally(() => pendingRuns.delete(promise));
  };

  /* QA: reviews a package once it is submitted. */

  // One in-flight review per work package, so it can be cancelled.
  const reviews = new Map();

  /** The Architect summary of the requirement a package came from, if any. */
  const interfacesFor = (task) => {
    if (!requirements || !task.requirementId) return null;
    try {
      return requirements.get(task.requirementId).interfaces?.text ?? null;
    } catch {
      return null;
    }
  };

  /**
   * Starts QA in the background. The renderer polls tasks:get for the
   * outcome; QA moves the package on itself when it finishes.
   */
  const startReview = async (id) => {
    const task = effectiveTask(id);
    const root = requireRoot();
    const baseline = requireBaseline(id);
    const entry = await store.beginReview(id);
    const controller = new AbortController();
    reviews.set(id, controller);
    const config = getConfig();
    const settled = (async () => {
      let outcome;
      try {
        const { path: envPath } = await commandPath();
        const result = await reviewWorkPackage(task, {
          root,
          baseline,
          runAgent,
          checks: submitChecks(config),
          runCheck: (kind, signal) => verification.runCheck(config, kind, { signal, envPath }),
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
      if (outcome.error) await store.failReview(id, outcome.error).catch(() => {});
      else await store.completeReview(id, outcome.result).catch((error) => store.failReview(id, error).catch(() => {}));
    })();
    track(settled);
    return entry;
  };

  /* Architect: rules on a reported deviation. */

  const adjudications = new Map(); // package id -> AbortController

  /**
   * Starts Architect's ruling in the background. Like QA, it moves the
   * package on itself: back to the developer, or to the queue with a new plan.
   * Without a workspace it still runs, on the package text alone.
   */
  const startAdjudication = async (id) => {
    const task = effectiveTask(id);
    const entry = await store.beginAdjudication(id);
    const controller = new AbortController();
    adjudications.set(id, controller);
    const settled = (async () => {
      let outcome;
      try {
        const { path: envPath } = await commandPath();
        const result = await adjudicateDeviation(task, {
          root: getConfig().root,
          deviations: entry.deviations,
          mustReplan: entry.adjudication.mustReplan,
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
      if (outcome.error) await store.failAdjudication(id, outcome.error).catch(() => {});
      else await store.completeAdjudication(id, outcome.result).catch((error) => store.failAdjudication(id, error).catch(() => {}));
    })();
    track(settled);
    return entry;
  };

  /* Baselines: the submit-stage checks run on the claimed commit. */

  const baselineRuns = new Map(); // package id -> AbortController

  /** Tracked files and HEAD; untracked files (build output) are allowed to appear. */
  const treeState = async (root) => {
    const entries = await git.status(root);
    return {
      head: await git.head(root),
      dirty: entries.filter((entry) => !entry.untracked).map((entry) => `${entry.status} ${entry.path}`).sort(),
    };
  };

  /**
   * Measures the baseline in the background. It only counts when the tree was
   * clean at the claimed commit before and after: a run over half-edited code
   * would blame or excuse the wrong tests.
   */
  const measureBaseline = async (id) => {
    const config = getConfig();
    const commit = store.get(id).baseline;
    if (!config.root || !commit) return;
    baselineRuns.get(id)?.abort();
    const controller = new AbortController();
    baselineRuns.set(id, controller);
    const checks = submitChecks(config);
    const startedAt = new Date().toISOString();
    const record = (status, extra = {}) => store.setBaselineChecks(id, {
      status, reason: null, commit, checks: {}, startedAt, finishedAt: new Date().toISOString(), ...extra,
    }).catch(() => null);

    const settled = (async () => {
      try {
        if (!checks.length) return void await record('unavailable', { reason: 'no_checks' });
        const before = await treeState(config.root);
        if (before.head !== commit) return void await record('unavailable', { reason: 'head_moved' });
        if (before.dirty.length) return void await record('unavailable', { reason: 'dirty_tree' });
        await record('measuring', { finishedAt: null });

        const { path: envPath } = await commandPath();
        const results = {};
        for (const check of checks) {
          if (controller.signal.aborted) break;
          try {
            const run = await verification.runCheck(config, check.kind, { signal: controller.signal, envPath });
            results[check.kind] = evidence.baselineRecord(run, check.line);
          } catch (error) {
            if (controller.signal.aborted) break;
            results[check.kind] = { status: 'unavailable', reason: error.code ?? 'failed', line: check.line };
          }
        }
        if (controller.signal.aborted) return void await record('unavailable', { reason: 'cancelled' });

        const after = await treeState(config.root);
        const same = after.head === commit && after.dirty.join('\n') === before.dirty.join('\n');
        await record(same ? 'measured' : 'contaminated', same ? { checks: results } : { reason: 'tree_changed' });
      } catch (error) {
        await record('unavailable', { reason: error.code ?? 'failed' });
      } finally {
        if (baselineRuns.get(id) === controller) baselineRuns.delete(id);
      }
    })();
    track(settled);
    return settled;
  };

  // Re-measuring is for a package claimed on a dirty tree, once it is clean.
  // It is only allowed before the developer has submitted anything.
  ipcMain.handle(CHANNELS.baselineMeasure, wrap(async (_event, id) => {
    requireString(id, 'id');
    requireBaseline(id);
    const state = store.get(id);
    if (state.status !== 'in_progress') failWith('Baselines can only be measured while the package is in progress', 'invalid_state');
    if (baselineRuns.has(id)) failWith('The baseline is already being measured', 'baseline_running');
    measureBaseline(id);
    return buildTaskView(effectiveTask(id), store.get(id));
  }));

  // `actor` is fixed to 'human': anything arriving from the renderer is a
  // human action by definition, so the renderer cannot claim to be an agent.
  ipcMain.handle(CHANNELS.transition, wrap(async (_event, id, name, options) => {
    requireString(id, 'id');
    requireString(name, 'name');
    const extra = {};
    if (name === 'claim') extra.baseline = await git.head(requireRoot());
    if (name === 'report_deviation') extra.deviation = options?.deviation;
    if (name === 'release') baselineRuns.get(id)?.abort();
    const entry = await store.transition(id, name, 'human', extra);
    if (name === 'claim') {
      measureBaseline(id);
      return entry;
    }
    if (name === 'report_deviation' || name === 'override_dismissal') {
      // The report stands even if Architect cannot start; it can be retried.
      try {
        return await startAdjudication(id);
      } catch (error) {
        await store.beginAdjudication(id).then(() => store.failAdjudication(id, error)).catch(() => {});
        return store.get(id);
      }
    }
    if (name !== 'submit_for_review') return entry;
    // The submission stands even if QA cannot start (no workspace, say);
    // the failure is recorded on the review and the user can retry.
    try {
      return await startReview(id);
    } catch (error) {
      await store.beginReview(id).then(() => store.failReview(id, error)).catch(() => {});
      return store.get(id);
    }
  }));

  ipcMain.handle(CHANNELS.reviewRetry, wrap((_event, id) => startReview(requireString(id, 'id'))));

  ipcMain.handle(CHANNELS.reviewCancel, wrap((_event, id) => {
    const controller = reviews.get(requireString(id, 'id'));
    if (!controller) return false;
    controller.abort();
    return true;
  }));

  ipcMain.handle(CHANNELS.deviationRetry, wrap((_event, id) => startAdjudication(requireString(id, 'id'))));

  ipcMain.handle(CHANNELS.deviationCancel, wrap((_event, id) => {
    const controller = adjudications.get(requireString(id, 'id'));
    if (!controller) return false;
    controller.abort();
    return true;
  }));

  ipcMain.handle(CHANNELS.setStepDone, wrap((_event, id, stepIndex, done) => {
    requireString(id, 'id');
    return store.setStepDone(id, stepIndex, done === true);
  }));

  ipcMain.handle(CHANNELS.workspaceGet, wrap(() => toFormView(getConfig())));

  // Validates everything before writing, so a bad path or command is never
  // persisted and reloaded on the next launch.
  ipcMain.handle(CHANNELS.workspaceSet, wrap(async (_event, form) => {
    const { config } = await validateForm(form);
    const saved = await workspace.save(configDir, config);
    setConfig(saved);
    return toFormView(saved);
  }));

  // Same validation as saving, plus a PATH lookup for each command, without
  // writing anything. Lets the settings page warn before the user commits.
  ipcMain.handle(CHANNELS.workspaceCheck, wrap(async (_event, form) => {
    const { config, info } = await validateForm(form);
    const { path: envPath } = await commandPath();
    const commands = {};
    for (const kind of workspace.COMMAND_KINDS) {
      const entry = config.commands[kind];
      commands[kind] = entry
        // Resolve against the PATH commands will actually run with.
        ? { configured: true, resolved: await workspace.resolveExecutable(entry.command, { cwd: config.root, envPath }) }
        : { configured: false, resolved: null };
    }
    return { root: config.root, normalizedFrom: info.normalizedFrom, repo: info.repo, commands };
  }));

  ipcMain.handle(CHANNELS.preferencesGet, wrap(() => preferences.toView(getPreferences())));

  ipcMain.handle(CHANNELS.preferencesSet, wrap(async (_event, raw) => {
    const previous = getPreferences();
    const saved = await preferences.save(configDir, raw);
    setPreferences(saved);
    // Switching the PATH source should take effect without a restart.
    if (saved.environment.pathSource !== previous.environment.pathSource) pathResolver.refresh();
    onPreferencesChanged?.(saved, previous);
    return preferences.toView(saved);
  }));

  // Reports which PATH verification commands will use and what it contains.
  // `source` lets the page preview a choice before saving it.
  ipcMain.handle(CHANNELS.environmentInfo, wrap(async (_event, options) => {
    const requested = options?.source ?? getPreferences().environment.pathSource;
    if (!preferences.PATH_SOURCES.includes(requested)) failWith(`Unknown PATH source: ${requested}`, 'invalid_argument');
    if (options?.refresh === true) pathResolver.refresh();
    const resolved = await pathResolver.resolve(requested);
    const entries = resolved.path.split(path.delimiter).filter(Boolean);
    return {
      requested,
      source: resolved.source,
      error: resolved.error,
      shell: process.env.SHELL ?? null,
      entries,
      inheritedCount: pathResolver.inherited.split(path.delimiter).filter(Boolean).length,
      platform: process.platform,
      versions: { app: appVersion ?? null, electron: process.versions.electron ?? null, node: process.versions.node },
    };
  }));

  ipcMain.handle(CHANNELS.dataInfo, wrap(() => ({
    configDir,
    files: [workspace.CONFIG_FILENAME, preferences.PREFERENCES_FILENAME, STATE_FILENAME],
    packages: store.summary(),
  })));

  // Only resets execution progress; workspace config and preferences stay.
  ipcMain.handle(CHANNELS.dataResetProgress, wrap(async () => {
    // Running reviews would otherwise write their result over the reset.
    for (const controller of reviews.values()) controller.abort();
    for (const controller of adjudications.values()) controller.abort();
    await Promise.allSettled([...pendingRuns]);
    await store.reset();
    return store.summary();
  }));

  ipcMain.handle(CHANNELS.dataReveal, wrap(async () => {
    if (!revealPath) failWith('Opening the folder is unavailable', 'unsupported');
    await revealPath(configDir);
    return true;
  }));

  /* Requirements: Product Lead clarifies, plans, and the human publishes. */

  // The handlers below use a local `store` for requirements, so keep a
  // separate name for the work package store.
  const workPackages = store;
  // One in-flight run per requirement, so it can be cancelled.
  const runs = new Map();

  const requireRequirements = () => {
    if (!requirements) failWith('Requirements are unavailable', 'unsupported');
    return requirements;
  };

  /**
   * Repository paths Product Lead sees: tracked files only (gitignored and
   * untracked files are left out), capped, and never their contents.
   */
  const repositoryFiles = async () => {
    const root = getConfig().root;
    if (!root) return [];
    try {
      return await git.listFiles(root, { limit: 400 });
    } catch {
      return [];
    }
  };

  /** Runs one Product Lead step in the background and records the outcome. */
  const startRun = async (id, step, buildPrompt, schema, validate, finish) => {
    const store = requireRequirements();
    const item = await store.begin(id, step);
    const controller = new AbortController();
    runs.set(id, controller);
    const files = await repositoryFiles();
    const { path: envPath } = await commandPath();
    // Not awaited: the renderer polls requirements:get for the result.
    const settled = (async () => {
      let outcome;
      try {
        // Architect summarizes the touched code once, during clarification;
        // planning reuses it. Re-clarifying refreshes it.
        let interfaces = item.interfaces?.text ?? null;
        let architectCost = 0;
        if (step === 'clarifying') {
          await store.setPhase(id, 'architect');
          const result = await summarizeForRequirement(item, {
            runAgent, root: getConfig().root, files, envPath, signal: controller.signal,
          });
          architectCost = result.costUsd;
          await store.setInterfaces(id, result.summary
            ? { summary: result.summary, text: result.text, read: result.read, skipped: result.skipped, error: null }
            : { summary: null, text: null, read: [], skipped: result.skipped, error: result.error });
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
      if (outcome.error) await store.failRun(id, step, outcome.error).catch(() => {});
      else await finish(id, outcome.output, outcome.costUsd).catch((error) => store.failRun(id, step, error).catch(() => {}));
    })();
    track(settled);
    return item;
  };

  ipcMain.handle(CHANNELS.requirementsList, wrap(() => requireRequirements().list()));

  ipcMain.handle(CHANNELS.requirementsGet, wrap((_event, id) => requireRequirements().get(requireString(id, 'id'))));

  ipcMain.handle(CHANNELS.requirementsCreate, wrap(async (_event, input) => {
    const item = await requireRequirements().create({ title: input?.title, text: input?.text });
    // Clarification starts right away; the page shows it running.
    return startRun(item.id, 'clarifying', productLead.clarifyPrompt, productLead.CLARIFY_SCHEMA, productLead.validateClarify,
      (rid, output, cost) => requirements.finishClarify(rid, output, cost));
  }));

  ipcMain.handle(CHANNELS.requirementsClarify, wrap((_event, id) => startRun(requireString(id, 'id'), 'clarifying',
    productLead.clarifyPrompt, productLead.CLARIFY_SCHEMA, productLead.validateClarify,
    (rid, output, cost) => requirements.finishClarify(rid, output, cost))));

  ipcMain.handle(CHANNELS.requirementsAnswer, wrap((_event, id, answers) => requireRequirements().setAnswers(requireString(id, 'id'), answers)));

  ipcMain.handle(CHANNELS.requirementsPlan, wrap(async (_event, id, answers) => {
    const rid = requireString(id, 'id');
    // Answers submitted with the plan request are saved first, in one step.
    if (answers !== undefined) await requireRequirements().setAnswers(rid, answers);
    return startRun(rid, 'planning', productLead.planPrompt, productLead.PLAN_SCHEMA, productLead.validatePlan,
      (r, output, cost) => requirements.finishPlan(r, output, cost));
  }));

  ipcMain.handle(CHANNELS.requirementsCancel, wrap((_event, id) => {
    const controller = runs.get(requireString(id, 'id'));
    if (!controller) return false;
    controller.abort();
    return true;
  }));

  // Publishing turns the reviewed plan into queue entries.
  ipcMain.handle(CHANNELS.requirementsPublish, wrap(async (_event, id) => {
    const store = requireRequirements();
    const item = store.get(requireString(id, 'id'));
    if (item.status !== 'reviewing' || !item.plan) failWith('There is no plan to publish', 'invalid_state');
    const definitions = productLead.toTaskDefinitions(item, item.plan.packages);
    const published = await store.publish(item.id, definitions);
    tasks.setGeneratedTasks(store.publishedPackages());
    workPackages.add(definitions);
    onPackagesPublished?.(definitions);
    return published;
  }));

  ipcMain.handle(CHANNELS.requirementsRemove, wrap(async (_event, id) => {
    const store = requireRequirements();
    const item = store.get(requireString(id, 'id'));
    // Published packages may already be claimed; removing them would orphan
    // that progress, so only unpublished requirements can be deleted.
    if (item.status === 'published') failWith('Published requirements cannot be deleted', 'invalid_state');
    await store.remove(item.id);
    return true;
  }));

  // Whether the Claude Code CLI can be found on the command PATH.
  ipcMain.handle(CHANNELS.agentStatus, wrap(async () => {
    const { path: envPath } = await commandPath();
    const resolved = await workspace.resolveExecutable('claude', { envPath });
    return { available: Boolean(resolved), command: resolved };
  }));

  ipcMain.handle(CHANNELS.workspacePickRoot, wrap(async () => {
    if (!pickDirectory) {
      const error = new Error('Directory picker is unavailable');
      error.code = 'unsupported';
      throw error;
    }
    return pickDirectory(getConfig().root);
  }));

  ipcMain.handle(CHANNELS.workspaceInfo, wrap(async () => {
    const config = getConfig();
    if (!config.root) return { configured: false };
    return { configured: true, root: config.root, ...(await git.describe(config.root)) };
  }));

  ipcMain.handle(CHANNELS.diffStat, wrap(async (_event, id) => {
    const root = requireRoot();
    const task = effectiveTask(requireString(id, 'id'));
    const changes = await git.changesSince(root, requireBaseline(id));
    return { changes, scope: tasks.checkFileScope(task, changes.map((c) => c.path)) };
  }));

  ipcMain.handle(CHANNELS.diffFile, wrap(async (_event, id, filePath) => {
    const root = requireRoot();
    return git.diffFile(root, requireBaseline(requireString(id, 'id')), safePath(root, filePath));
  }));

  ipcMain.handle(CHANNELS.verifyRun, wrap(async (_event, kind, taskId) => {
    if (!workspace.COMMAND_KINDS.includes(kind)) {
      const error = new Error(`Unknown verification kind: ${kind}`);
      error.code = 'invalid_argument';
      throw error;
    }
    const config = getConfig();
    const result = await verification.runCheck(config, kind, { envPath: (await commandPath()).path });
    if (!taskId) return result;
    const task = effectiveTask(requireString(taskId, 'taskId'));
    // The same comparison a review makes, so a manual run reads the same way.
    const check = { kind, stage: config.checks[kind].stage, blocking: config.checks[kind].blocking, line: checkLine(config.checks[kind]) };
    const baselines = store.get(task.id).baselineChecks?.checks ?? {};
    const item = evidence.evaluate(check, result, evidence.usableBaseline(baselines[kind], check.line));
    return {
      ...result,
      evidence: item,
      acceptance: evidence.criteriaStatus(task.acceptance ?? [], { [kind]: result }, [item], baselines),
    };
  }));

  /* Environment Steward */

  // One session per app run, in memory only: the plan is cheap to redo and
  // must not outlive the toolchain it was made for.
  let env = { root: null, status: 'idle', facts: null, blockers: [], plan: null, error: null, costUsd: 0, allowScripts: false, results: {}, running: null };
  let envController = null;
  const ENV_OUTPUT_CHARS = 4000;

  const envSteps = () => (env.plan ? envSetup.buildSteps(env.plan, env.facts, { allowScripts: env.allowScripts }) : []);

  const envView = () => ({
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
      script: step.script ?? null,
      line: workspace.formatCommandLine(step),
      result: env.results[step.id] ?? null,
    })),
    configured: Object.fromEntries(workspace.COMMAND_KINDS.map((kind) => [kind, workspace.formatCommandLine(getConfig().commands[kind])])),
  });

  const requireEnvPlan = () => {
    if (env.status !== 'ready' || !env.plan) failWith('No environment plan is ready', 'env_no_plan');
    if (env.root !== getConfig().root) failWith('The workspace changed since this plan was made', 'env_stale');
    if (env.running) failWith('A setup step is already running', 'env_busy');
  };

  ipcMain.handle(CHANNELS.envGet, wrap(() => envView()));

  ipcMain.handle(CHANNELS.envPlan, wrap(async (_event, options) => {
    const root = requireRoot();
    if (env.status === 'planning' || env.running) failWith('The Environment Steward is busy', 'env_busy');
    // Re-planning after a failure hands the steward that step's output.
    let failure = null;
    if (options?.withFailure === true && env.root === root) {
      const failed = envSteps().find((step) => env.results[step.id] && !env.results[step.id].ok);
      if (failed) {
        const result = env.results[failed.id];
        failure = { step: failed.id, command: workspace.formatCommandLine(failed), exitCode: result.exitCode, timedOut: result.timedOut, output: result.output };
      }
    }
    const keepResults = failure !== null;
    env = {
      root, status: 'planning', facts: null, blockers: [], plan: null, error: null, costUsd: 0,
      allowScripts: keepResults ? env.allowScripts : false, results: keepResults ? env.results : {}, running: null,
    };
    const session = env;
    const controller = new AbortController();
    envController = controller;
    const { path: envPath } = await commandPath();
    track((async () => {
      try {
        const outcome = await planEnvironment({ root, runAgent, envPath, signal: controller.signal, failure });
        Object.assign(session, { status: 'ready', facts: outcome.facts, blockers: outcome.blockers, plan: outcome.plan, costUsd: outcome.costUsd });
        // Results only carry over for steps the new plan still runs unchanged.
        const lines = new Map(envSteps().map((step) => [step.id, workspace.formatCommandLine(step)]));
        for (const id of Object.keys(session.results)) {
          if (session.results[id].line !== lines.get(id)) delete session.results[id];
        }
      } catch (error) {
        Object.assign(session, { status: 'failed', error: toFailure(error).error });
      } finally {
        if (envController === controller) envController = null;
      }
    })());
    return envView();
  }));

  ipcMain.handle(CHANNELS.envSetAllowScripts, wrap((_event, allow) => {
    if (env.running) failWith('A setup step is already running', 'env_busy');
    env.allowScripts = allow === true;
    delete env.results.install;
    return envView();
  }));

  // The click is the user's confirmation; the command itself is rebuilt here
  // from the stored plan, never taken from the renderer.
  ipcMain.handle(CHANNELS.envRunStep, wrap(async (_event, stepId) => {
    requireString(stepId, 'stepId');
    requireEnvPlan();
    const step = envSteps().find((candidate) => candidate.id === stepId);
    if (!step) failWith(`Unknown setup step: ${stepId}`, 'invalid_argument');
    const blocking = env.blockers.filter((code) => code !== 'unsupported_manager' || step.kind === 'install');
    if (blocking.length) failWith(`Setup is blocked: ${blocking.join(', ')}`, 'env_blocked');

    const session = env;
    const controller = new AbortController();
    envController = controller;
    session.running = step.id;
    const line = workspace.formatCommandLine(step);
    const run = (async () => {
      try {
        const result = await verification.run(
          { root: session.root, commands: { [step.kind]: { command: step.command, args: step.args } } },
          step.kind,
          { signal: controller.signal, envPath: (await commandPath()).path, timeoutMs: 15 * 60 * 1000 },
        );
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
  }));

  // Copies the plan's verification scripts into workspace.json, for the
  // kinds the user ticked. Lines are rebuilt here, as in envRunStep.
  ipcMain.handle(CHANNELS.envApply, wrap(async (_event, kinds) => {
    requireEnvPlan();
    if (!Array.isArray(kinds) || kinds.some((kind) => !envSetup.SCRIPT_KINDS.includes(kind))) {
      failWith('kinds must be a list of test, lint or build', 'invalid_argument');
    }
    const config = getConfig();
    const checks = { ...config.checks };
    for (const kind of new Set(kinds)) {
      const name = env.plan.scripts[kind];
      if (!name) failWith(`The plan has no ${kind} script`, 'invalid_argument');
      // A new command keeps the slot's stage and blocking choice; its report
      // format resets, since the old one described a different command.
      const kept = checks[kind];
      checks[kind] = { ...envSetup.scriptCommand(name), stage: kept?.stage, blocking: kept?.blocking };
    }
    setConfig(await workspace.save(configDir, { ...config, checks }));
    return envView();
  }));

  ipcMain.handle(CHANNELS.envCancel, wrap(() => {
    if (!envController) return false;
    envController.abort();
    return true;
  }));

  return {
    /** Cancels running agents and waits for their final writes. */
    async shutdown() {
      envController?.abort();
      for (const controller of baselineRuns.values()) controller.abort();
      for (const controller of runs.values()) controller.abort();
      for (const controller of reviews.values()) controller.abort();
      for (const controller of adjudications.values()) controller.abort();
      await Promise.allSettled([...pendingRuns]);
    },
  };
}

module.exports = { CHANNELS, buildTaskView, toFormView, registerIpcHandlers };
