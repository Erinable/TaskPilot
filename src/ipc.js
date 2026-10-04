// The renderer's only route to the filesystem, git and command execution.
// Every handler validates its arguments here: the renderer is treated as
// untrusted input, since the content it displays originates from AI agents.
const tasks = require('./tasks');
const git = require('./git');
const workspace = require('./workspace');
const verification = require('./verification');
const { label, available } = require('./work-package-status');

const CHANNELS = {
  listTasks: 'tasks:list',
  getTask: 'tasks:get',
  transition: 'package:transition',
  setStepDone: 'package:set-step-done',
  workspaceGet: 'workspace:get',
  workspaceSet: 'workspace:set',
  workspaceInfo: 'workspace:info',
  diffStat: 'diff:stat',
  diffFile: 'diff:file',
  verifyRun: 'verify:run',
};

/** Shaped like an Error but safe to send over IPC. */
function toFailure(error) {
  return { ok: false, error: { code: error.code ?? 'unknown', message: error.message } };
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
 */
function registerIpcHandlers(ipcMain, deps) {
  const { store, configDir, getConfig, setConfig } = deps;

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

  ipcMain.handle(CHANNELS.workspaceGet, wrap(() => getConfig()));

  ipcMain.handle(CHANNELS.workspaceSet, wrap(async (_event, raw) => {
    const saved = await workspace.save(configDir, raw);
    if (saved.root && !(await git.isRepo(saved.root))) {
      const error = new Error('Workspace root is not a git repository');
      error.code = 'not_a_repo';
      throw error;
    }
    setConfig(saved);
    return saved;
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
    const result = await verification.run(getConfig(), kind);
    if (!taskId) return result;
    const task = tasks.getTask(requireString(taskId, 'taskId'));
    return { ...result, acceptance: verification.matchAcceptance(task.acceptance, result.results) };
  }));
}

module.exports = { CHANNELS, buildTaskView, registerIpcHandlers };
