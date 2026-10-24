// Only these named calls are exposed: the renderer never gets ipcRenderer
// itself, so it cannot reach a channel that isn't listed below. The preload is
// bundled, so it shares channel names with the main process.
import { contextBridge, ipcRenderer } from 'electron';

import { CHANNELS } from '../shared/ipc_channels.ts';
import type { Channel } from '../shared/ipc_channels.ts';
import type * as ipc from '../shared/ipc_types.ts';

const invoke = <T>(channel: Channel, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args) as Promise<ipc.IpcResult<T>>;

// Passed by the main process (see BrowserWindow additionalArguments).
const TIME_ZONE_ARG = '--taskpilot-time-zone=';
const timeZoneArg = process.argv.find((arg) => arg.startsWith(TIME_ZONE_ARG));
if (!timeZoneArg) throw new Error('The main process did not pass the business time zone');

const api = {
  // IANA name; day boundaries and displayed times follow it.
  businessTimeZone: timeZoneArg.slice(TIME_ZONE_ARG.length),
  listTasks: () => invoke<ipc.TaskView[]>(CHANNELS.listTasks),
  getTask: (id: string) => invoke<ipc.TaskView>(CHANNELS.getTask, id),

  transition: (id: string, name: ipc.HumanTransition, options?: ipc.TransitionOptions) => invoke<ipc.WorkPackageState>(CHANNELS.transition, id, name, options),
  waiveDependency: (id: string, dependency: string) => invoke<ipc.TaskView>(CHANNELS.waiveDependency, id, dependency),
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
    openFile: (filePath: string, line: number | null = null) => invoke<ipc.OpenedWith>(CHANNELS.workspaceOpenFile, filePath, line),
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
    runtimes: () => invoke<ipc.AgentRuntimeStatus[]>(CHANNELS.agentRuntimes),
    models: (request: ipc.CliModelsRequest) => invoke<ipc.CliModelCatalog>(CHANNELS.agentModels, request),
  },
  coding: {
    status: () => invoke<ipc.CodingRuntimeStatus>(CHANNELS.codingStatus),
    start: (id: string, input: ipc.CodingStart) => invoke<ipc.TaskView>(CHANNELS.codingStart, id, input),
    get: (id: string) => invoke<ipc.TaskView>(CHANNELS.codingGet, id),
    events: (id: string, after: number) => invoke<ipc.CodingEventPage>(CHANNELS.codingEvents, id, after),
    cancel: (id: string) => invoke<boolean>(CHANNELS.codingCancel, id),
    patch: (id: string) => invoke<ipc.CodingPatchPreview>(CHANNELS.codingPatch, id),
    apply: (id: string, input: ipc.CodingApply) => invoke<ipc.CodingApplyResult>(CHANNELS.codingApply, id, input),
    resume: (id: string) => invoke<ipc.TaskView>(CHANNELS.codingResume, id),
    active: () => invoke<ipc.CodingActiveRun[]>(CHANNELS.codingActive),
  },

  activity: {
    overview: () => invoke<ipc.ActivityOverview>(CHANNELS.activityOverview),
    page: (before: string | null) => invoke<ipc.ActivityPage>(CHANNELS.activityPage, before),
  },

  costs: {
    report: (days: ipc.CostRange) => invoke<ipc.CostReport>(CHANNELS.costsReport, days),
    // The one outbound request: downloads the models.dev price list.
    syncPrices: () => invoke<{ syncedAt: string }>(CHANNELS.costsSyncPrices),
  },

  engineeringMap: {
    get: () => invoke<ipc.EngineeringMap>(CHANNELS.engineeringMap),
  },

  env: {
    get: () => invoke<ipc.EnvState>(CHANNELS.envGet),
    plan: (options?: ipc.EnvPlanOptions) => invoke<ipc.EnvState>(CHANNELS.envPlan, options),
    setAllowScripts: (allow: boolean) => invoke<ipc.EnvState>(CHANNELS.envSetAllowScripts, allow),
    runStep: (stepId: string) => invoke<ipc.EnvState>(CHANNELS.envRunStep, stepId),
    apply: (kinds: ipc.ScriptKind[]) => invoke<ipc.EnvApplyResult>(CHANNELS.envApply, kinds),
    cancel: () => invoke<boolean>(CHANNELS.envCancel),
  },

  release: {
    get: () => invoke<ipc.ReleaseState>(CHANNELS.releaseGet),
    recentCommits: () => invoke<ipc.ReleaseCommit[]>(CHANNELS.releaseRecentCommits),
    generate: (startCommit?: string) => invoke<ipc.ReleaseState>(CHANNELS.releaseGenerate, startCommit),
    updateDraft: (input: ipc.ReleaseDraftInput) => invoke<ipc.ReleaseState>(CHANNELS.releaseUpdateDraft, input),
    finish: () => invoke<ipc.Release>(CHANNELS.releaseFinish),
    writeNotes: (input: ipc.ReleaseWriteInput) => invoke<ipc.ReleaseWriteResult>(CHANNELS.releaseWriteNotes, input),
    cancel: () => invoke<boolean>(CHANNELS.releaseCancel),
    createMilestone: (input: ipc.MilestoneInput) => invoke<ipc.ReleaseState>(CHANNELS.milestoneCreate, input),
    updateMilestone: (id: string, input: ipc.MilestoneInput) => invoke<ipc.ReleaseState>(CHANNELS.milestoneUpdate, id, input),
    deleteMilestone: (id: string) => invoke<ipc.ReleaseState>(CHANNELS.milestoneDelete, id),
    assignMilestone: (requirementId: string, milestoneId: string | null) => invoke<ipc.ReleaseState>(CHANNELS.milestoneAssign, requirementId, milestoneId),
  },

  repositories: {
    list: () => invoke<ipc.RepositoryList>(CHANNELS.repositoriesList),
    // Validates and registers a root; `open` also switches to it.
    add: (root: string, open: boolean) => invoke<ipc.RepositoryList>(CHANNELS.repositoriesAdd, root, open),
    // Cancels running work first; ask with busy() before calling.
    switch: (id: string) => invoke<ipc.RepositoryList>(CHANNELS.repositoriesSwitch, id),
    relocate: (id: string, root: string) => invoke<ipc.RepositoryList>(CHANNELS.repositoriesRelocate, id, root),
    busy: () => invoke<ipc.BusyRun[]>(CHANNELS.repositoriesBusy),
  },

  commit: {
    preview: (id: string) => invoke<ipc.CommitPreview>(CHANNELS.commitPreview, id),
    // `files` is the list the developer reviewed; a changed list is refused.
    create: (id: string, message: string, files: string[]) => invoke<ipc.CommitResult>(CHANNELS.commitCreate, id, message, files),
  },

  tutor: {
    get: (id: string, stepIndex: number) => invoke<ipc.TutorState>(CHANNELS.tutorGet, id, stepIndex),
    // Starts Tutor in the background; poll get() for the answer.
    ask: (id: string, stepIndex: number) => invoke<ipc.TutorState>(CHANNELS.tutorAsk, id, stepIndex),
    cancel: (id: string, stepIndex: number) => invoke<boolean>(CHANNELS.tutorCancel, id, stepIndex),
  },

  practice: {
    // The reference patch; refused until the package was first submitted.
    reference: (id: string) => invoke<string>(CHANNELS.referenceGet, id),
    // Grades now: a retry, or without waiting for the reference.
    grade: (id: string, skipReference: boolean) => invoke<ipc.TaskView>(CHANNELS.gradeStart, id, skipReference),
  },

  notes: {
    // Every note without its body; `since` returns null when nothing changed.
    list: (since: number | null) => invoke<ipc.NoteList | null>(CHANNELS.notesList, since),
    get: (id: string) => invoke<ipc.Note>(CHANNELS.notesGet, id),
    // Ids of notes whose title, tags or body contain the query.
    search: (query: string) => invoke<string[]>(CHANNELS.notesSearch, query),
    // autoRename: a taken title gets a number instead of being refused.
    create: (input: ipc.NoteInput, autoRename: boolean) => invoke<ipc.NoteSaved>(CHANNELS.notesCreate, input, autoRename),
    // The source stays as recorded; only the developer's text changes.
    update: (id: string, edit: ipc.NoteEdit) => invoke<ipc.NoteSaved>(CHANNELS.notesUpdate, id, edit),
    // Moves the file to the system trash.
    remove: (id: string) => invoke<boolean>(CHANNELS.notesDelete, id),
    // Tutor writes the note's summary (costs a model call).
    summarize: (id: string, baseVersion: string) => invoke<ipc.NoteSaved>(CHANNELS.notesSummarize, id, baseVersion),
    // null goes back to the default folder; files are never moved.
    setDirectory: (directory: string | null) => invoke<ipc.NoteList>(CHANNELS.notesSetDirectory, directory),
    pickDirectory: () => invoke<string | null>(CHANNELS.notesPickDirectory),
    reveal: () => invoke<boolean>(CHANNELS.notesReveal),
    // http(s) and mailto links only, opened by the system.
    openUrl: (url: string) => invoke<boolean>(CHANNELS.notesOpenUrl, url),
  },
};

export type TaskPilotApi = typeof api;

contextBridge.exposeInMainWorld('taskpilot', api);
