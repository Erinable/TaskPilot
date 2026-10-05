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
const { summarizeForRequirement, throwIfCancelled } = require('./agents/pipeline');
const { STATE_FILENAME } = require('./work-package-store');
const { label, available } = require('./work-package-status');

const CHANNELS = {
  listTasks: 'tasks:list',
  getTask: 'tasks:get',
  transition: 'package:transition',
  setStepDone: 'package:set-step-done',
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
};

/** Shaped like an Error but safe to send over IPC. */
function toFailure(error) {
  const failure = { code: error.code ?? 'unknown', message: error.message };
  if (error.field) failure.field = error.field;
  return { ok: false, error: failure };
}

/** Config plus the command lines the settings form edits. */
function toFormView(config) {
  const lines = {};
  for (const kind of workspace.COMMAND_KINDS) lines[kind] = workspace.formatCommandLine(config.commands[kind]);
  return { root: config.root, commands: config.commands, lines };
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

function buildTaskView(task, state) {
  return {
    ...task,
    status: state.status,
    statusLabel: label(state.status),
    baseline: state.baseline,
    claimedAt: state.claimedAt,
    completedSteps: state.completedSteps,
    deviations: state.deviations,
    humanTransitions: available(state.status, 'human').map((t) => t.name),
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
    const config = workspace.fromForm(form);
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

  ipcMain.handle(CHANNELS.listTasks, wrap(() => {
    const state = store.all();
    return tasks.listTasks().map((task) => buildTaskView(task, state[task.id]));
  }));

  ipcMain.handle(CHANNELS.getTask, wrap((_event, id) => {
    const task = tasks.getTask(requireString(id, 'id'));
    if (!task) {
      const error = new Error(`Unknown work package: ${id}`);
      error.code = 'unknown_package';
      throw error;
    }
    return buildTaskView(task, store.get(id));
  }));

  // `actor` is fixed to 'human': anything arriving from the renderer is a
  // human action by definition, so the renderer cannot claim to be an agent.
  ipcMain.handle(CHANNELS.transition, wrap(async (_event, id, name, options) => {
    requireString(id, 'id');
    requireString(name, 'name');
    const extra = {};
    if (name === 'claim') extra.baseline = await git.head(requireRoot());
    if (name === 'report_deviation') extra.deviation = options?.deviation;
    return store.transition(id, name, 'human', extra);
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
  // Background run promises, so shutdown (and tests) can wait for writes.
  const pendingRuns = new Set();

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
    pendingRuns.add(settled);
    settled.finally(() => pendingRuns.delete(settled));
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
    const task = tasks.getTask(requireString(id, 'id'));
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
    const result = await verification.run(getConfig(), kind, { envPath: (await commandPath()).path });
    if (!taskId) return result;
    const task = tasks.getTask(requireString(taskId, 'taskId'));
    return { ...result, acceptance: verification.matchAcceptance(task.acceptance, result.results) };
  }));

  return {
    /** Cancels running agents and waits for their final writes. */
    async shutdown() {
      for (const controller of runs.values()) controller.abort();
      await Promise.allSettled([...pendingRuns]);
    },
  };
}

module.exports = { CHANNELS, buildTaskView, toFormView, registerIpcHandlers };
