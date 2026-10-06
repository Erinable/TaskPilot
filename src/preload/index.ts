// Only these named calls are exposed: the renderer never gets ipcRenderer
// itself, so it cannot reach a channel that isn't listed below. The preload is
// bundled, so it shares channel names with the main process.
import { contextBridge, ipcRenderer } from 'electron';

import { CHANNELS } from '../shared/ipc_channels.ts';
import type { Channel } from '../shared/ipc_channels.ts';
import type * as ipc from '../shared/ipc_types.ts';

const invoke = <T>(channel: Channel, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args) as Promise<ipc.IpcResult<T>>;

const api = {
  listTasks: () => invoke<ipc.TaskView[]>(CHANNELS.listTasks),
  getTask: (id: string) => invoke<ipc.TaskView>(CHANNELS.getTask, id),

  transition: (id: string, name: ipc.HumanTransition, options?: ipc.TransitionOptions) => invoke<ipc.WorkPackageState>(CHANNELS.transition, id, name, options),
  measureBaseline: (id: string) => invoke<ipc.TaskView>(CHANNELS.baselineMeasure, id),
  setStepDone: (id: string, stepIndex: number, done: boolean) => invoke<ipc.WorkPackageState>(CHANNELS.setStepDone, id, stepIndex, done),

  review: {
    retry: (id: string) => invoke<ipc.WorkPackageState>(CHANNELS.reviewRetry, id),
    cancel: (id: string) => invoke<boolean>(CHANNELS.reviewCancel, id),
  },

  deviation: {
    retry: (id: string) => invoke<ipc.WorkPackageState>(CHANNELS.deviationRetry, id),
    cancel: (id: string) => invoke<boolean>(CHANNELS.deviationCancel, id),
  },

  workspace: {
    get: () => invoke<ipc.WorkspaceView>(CHANNELS.workspaceGet),
    set: (form: ipc.WorkspaceForm) => invoke<ipc.WorkspaceView>(CHANNELS.workspaceSet, form),
    check: (form: ipc.WorkspaceForm) => invoke<ipc.WorkspaceCheck>(CHANNELS.workspaceCheck, form),
    pickRoot: () => invoke<string | null>(CHANNELS.workspacePickRoot),
    info: () => invoke<ipc.WorkspaceInfo>(CHANNELS.workspaceInfo),
  },

  diff: {
    stat: (id: string) => invoke<ipc.DiffStat>(CHANNELS.diffStat, id),
    file: (id: string, filePath: string) => invoke<ipc.DiffFile>(CHANNELS.diffFile, id, filePath),
  },

  verify: {
    run: (kind: ipc.CheckKind, taskId?: string) => invoke<ipc.VerifyRun>(CHANNELS.verifyRun, kind, taskId),
  },

  preferences: {
    get: () => invoke<ipc.Preferences>(CHANNELS.preferencesGet),
    set: (prefs: ipc.PreferencesInput) => invoke<ipc.Preferences>(CHANNELS.preferencesSet, prefs),
  },

  environment: {
    info: (options?: ipc.EnvironmentInfoOptions) => invoke<ipc.EnvironmentInfo>(CHANNELS.environmentInfo, options),
  },

  data: {
    info: () => invoke<ipc.DataInfo>(CHANNELS.dataInfo),
    resetProgress: () => invoke<ipc.PackageSummary>(CHANNELS.dataResetProgress),
    reveal: () => invoke<true>(CHANNELS.dataReveal),
  },

  requirements: {
    list: () => invoke<ipc.Requirement[]>(CHANNELS.requirementsList),
    get: (id: string) => invoke<ipc.Requirement>(CHANNELS.requirementsGet, id),
    create: (input: ipc.RequirementInput) => invoke<ipc.Requirement>(CHANNELS.requirementsCreate, input),
    clarify: (id: string) => invoke<ipc.Requirement>(CHANNELS.requirementsClarify, id),
    answer: (id: string, answers: ipc.RequirementAnswers) => invoke<ipc.Requirement>(CHANNELS.requirementsAnswer, id, answers),
    plan: (id: string, answers?: ipc.RequirementAnswers) => invoke<ipc.Requirement>(CHANNELS.requirementsPlan, id, answers),
    publish: (id: string) => invoke<ipc.Requirement>(CHANNELS.requirementsPublish, id),
    remove: (id: string) => invoke<true>(CHANNELS.requirementsRemove, id),
    cancel: (id: string) => invoke<boolean>(CHANNELS.requirementsCancel, id),
  },

  agent: {
    status: () => invoke<ipc.AgentStatus>(CHANNELS.agentStatus),
  },

  env: {
    get: () => invoke<ipc.EnvState>(CHANNELS.envGet),
    plan: (options?: ipc.EnvPlanOptions) => invoke<ipc.EnvState>(CHANNELS.envPlan, options),
    setAllowScripts: (allow: boolean) => invoke<ipc.EnvState>(CHANNELS.envSetAllowScripts, allow),
    runStep: (stepId: string) => invoke<ipc.EnvState>(CHANNELS.envRunStep, stepId),
    apply: (kinds: ipc.ScriptKind[]) => invoke<ipc.EnvApplyResult>(CHANNELS.envApply, kinds),
    cancel: () => invoke<boolean>(CHANNELS.envCancel),
  },
};

export type TaskPilotApi = typeof api;

contextBridge.exposeInMainWorld('taskpilot', api);
