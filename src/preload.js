// Sandboxed preloads can only require 'electron', so channel names are
// duplicated here rather than imported from ./ipc. tests/ipc.test.js guards
// against the two drifting apart.
//
// Only these named calls are exposed: the renderer never gets ipcRenderer
// itself, so it cannot reach a channel that isn't listed below.
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('taskpilot', {
  listTasks: () => invoke('tasks:list'),
  getTask: (id) => invoke('tasks:get', id),

  transition: (id, name, options) => invoke('package:transition', id, name, options),
  measureBaseline: (id) => invoke('baseline:measure', id),
  setStepDone: (id, stepIndex, done) => invoke('package:set-step-done', id, stepIndex, done),

  review: {
    retry: (id) => invoke('review:retry', id),
    cancel: (id) => invoke('review:cancel', id),
  },

  workspace: {
    get: () => invoke('workspace:get'),
    set: (form) => invoke('workspace:set', form),
    check: (form) => invoke('workspace:check', form),
    pickRoot: () => invoke('workspace:pick-root'),
    info: () => invoke('workspace:info'),
  },

  diff: {
    stat: (id) => invoke('diff:stat', id),
    file: (id, filePath) => invoke('diff:file', id, filePath),
  },

  verify: {
    run: (kind, taskId) => invoke('verify:run', kind, taskId),
  },

  preferences: {
    get: () => invoke('preferences:get'),
    set: (prefs) => invoke('preferences:set', prefs),
  },

  environment: {
    info: (options) => invoke('environment:info', options),
  },

  data: {
    info: () => invoke('data:info'),
    resetProgress: () => invoke('data:reset-progress'),
    reveal: () => invoke('data:reveal'),
  },

  requirements: {
    list: () => invoke('requirements:list'),
    get: (id) => invoke('requirements:get', id),
    create: (input) => invoke('requirements:create', input),
    clarify: (id) => invoke('requirements:clarify', id),
    answer: (id, answers) => invoke('requirements:answer', id, answers),
    plan: (id, answers) => invoke('requirements:plan', id, answers),
    publish: (id) => invoke('requirements:publish', id),
    remove: (id) => invoke('requirements:remove', id),
    cancel: (id) => invoke('requirements:cancel', id),
  },

  agent: {
    status: () => invoke('agent:status'),
  },

  env: {
    get: () => invoke('env:get'),
    plan: (options) => invoke('env:plan', options),
    setAllowScripts: (allow) => invoke('env:set-allow-scripts', allow),
    runStep: (stepId) => invoke('env:run-step', stepId),
    apply: (kinds) => invoke('env:apply', kinds),
    cancel: () => invoke('env:cancel'),
  },
});
