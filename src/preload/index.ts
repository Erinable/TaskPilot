// Only these named calls are exposed: the renderer never gets ipcRenderer
// itself, so it cannot reach a channel that isn't listed below. The preload is
// bundled, so it shares channel names with the main process.
import { contextBridge, ipcRenderer } from 'electron';

import { CHANNELS } from '../shared/ipc_channels.ts';
import type { Channel } from '../shared/ipc_channels.ts';
import type * as activityTypes from '../shared/ipc/activity.ts';
import type * as agentRuntimeTypes from '../shared/agent_runtime.ts';
import type * as codingTypes from '../shared/coding_types.ts';
import type * as commitTypes from '../shared/ipc/commit.ts';
import type * as courseTypes from '../shared/ipc/courses.ts';
import type * as envelopeTypes from '../shared/ipc/envelope.ts';
import type * as envTypes from '../shared/ipc/environment.ts';
import type * as noteTypes from '../shared/ipc/notes.ts';
import type * as packageTypes from '../shared/ipc/packages.ts';
import type * as releaseTypes from '../shared/ipc/release.ts';
import type * as repositoryTypes from '../shared/ipc/repositories.ts';
import type * as requirementTypes from '../shared/ipc/requirements.ts';
import type * as settingsTypes from '../shared/ipc/settings.ts';
import type * as tutorTypes from '../shared/ipc/tutor.ts';
import type * as workspaceTypes from '../shared/ipc/workspace.ts';
import type { CoursePack } from '../shared/course_pack.ts';
import type { PathEntry } from '../shared/course_plan.ts';

const invoke = <T>(channel: Channel, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args) as Promise<envelopeTypes.IpcResult<T>>;

// Passed by the main process (see BrowserWindow additionalArguments).
const TIME_ZONE_ARG = '--taskpilot-time-zone=';
const timeZoneArg = process.argv.find((arg) => arg.startsWith(TIME_ZONE_ARG));
if (!timeZoneArg) throw new Error('The main process did not pass the business time zone');

const api = {
  // IANA name; day boundaries and displayed times follow it.
  businessTimeZone: timeZoneArg.slice(TIME_ZONE_ARG.length),
  // Calls back with whether the window is full screen, now and on each change.
  onFullScreen: (listener: (fullScreen: boolean) => void) => {
    ipcRenderer.on(CHANNELS.windowFullScreen, (_event, fullScreen: unknown) => listener(fullScreen === true));
  },
  // Every other call waits for this: the stores load after the window opens.
  startupReady: (retry: boolean) => invoke<boolean>(CHANNELS.startupReady, retry),
  listTasks: () => invoke<packageTypes.TaskView[]>(CHANNELS.listTasks),
  getTask: (id: string) => invoke<packageTypes.TaskView>(CHANNELS.getTask, id),

  transition: (id: string, name: packageTypes.HumanTransition, options?: packageTypes.TransitionOptions) =>
    invoke<packageTypes.WorkPackageState>(CHANNELS.transition, id, name, options),
  waiveDependency: (id: string, dependency: string) => invoke<packageTypes.TaskView>(CHANNELS.waiveDependency, id, dependency),
  measureBaseline: (id: string) => invoke<packageTypes.TaskView>(CHANNELS.baselineMeasure, id),
  setStepDone: (id: string, stepIndex: number, done: boolean) => invoke<packageTypes.WorkPackageState>(CHANNELS.setStepDone, id, stepIndex, done),

  review: {
    retry: (id: string) => invoke<packageTypes.WorkPackageState>(CHANNELS.reviewRetry, id),
    cancel: (id: string) => invoke<boolean>(CHANNELS.reviewCancel, id),
  },

  deviation: {
    retry: (id: string) => invoke<packageTypes.WorkPackageState>(CHANNELS.deviationRetry, id),
    cancel: (id: string) => invoke<boolean>(CHANNELS.deviationCancel, id),
  },

  workspace: {
    get: () => invoke<workspaceTypes.WorkspaceView>(CHANNELS.workspaceGet),
    set: (form: workspaceTypes.WorkspaceForm) => invoke<workspaceTypes.WorkspaceView>(CHANNELS.workspaceSet, form),
    check: (form: workspaceTypes.WorkspaceForm) => invoke<workspaceTypes.WorkspaceCheck>(CHANNELS.workspaceCheck, form),
    pickRoot: () => invoke<string | null>(CHANNELS.workspacePickRoot),
    info: () => invoke<workspaceTypes.WorkspaceInfo>(CHANNELS.workspaceInfo),
    // Writes taskpilot.toml naming `preset`; refuses when one exists.
    createProject: (preset: string) => invoke<workspaceTypes.WorkspaceView>(CHANNELS.workspaceCreateProject, preset),
    // Confirms the repository's course pack with the content hash the user saw.
    confirmCourse: (id: string, contentHash: string) => invoke<workspaceTypes.WorkspaceView>(CHANNELS.workspaceConfirmCourse, id, contentHash),
    openFile: (filePath: string, line: number | null = null) => invoke<workspaceTypes.OpenedWith>(CHANNELS.workspaceOpenFile, filePath, line),
  },

  diff: {
    stat: (id: string) => invoke<workspaceTypes.DiffStat>(CHANNELS.diffStat, id),
    file: (id: string, filePath: string) => invoke<workspaceTypes.DiffFile>(CHANNELS.diffFile, id, filePath),
  },

  verify: {
    run: (kind: workspaceTypes.CheckKind, taskId?: string) => invoke<workspaceTypes.VerifyRun>(CHANNELS.verifyRun, kind, taskId),
  },

  preferences: {
    get: () => invoke<settingsTypes.Preferences>(CHANNELS.preferencesGet),
    set: (prefs: settingsTypes.PreferencesInput) => invoke<settingsTypes.Preferences>(CHANNELS.preferencesSet, prefs),
  },

  environment: {
    info: (options?: settingsTypes.EnvironmentInfoOptions) => invoke<settingsTypes.EnvironmentInfo>(CHANNELS.environmentInfo, options),
  },

  data: {
    info: () => invoke<settingsTypes.DataInfo>(CHANNELS.dataInfo),
    resetProgress: () => invoke<settingsTypes.PackageSummary>(CHANNELS.dataResetProgress),
    reveal: () => invoke<true>(CHANNELS.dataReveal),
  },

  requirements: {
    list: () => invoke<requirementTypes.Requirement[]>(CHANNELS.requirementsList),
    get: (id: string) => invoke<requirementTypes.Requirement>(CHANNELS.requirementsGet, id),
    create: (input: requirementTypes.RequirementInput) => invoke<requirementTypes.Requirement>(CHANNELS.requirementsCreate, input),
    clarify: (id: string) => invoke<requirementTypes.Requirement>(CHANNELS.requirementsClarify, id),
    answer: (id: string, answers: requirementTypes.RequirementAnswers) => invoke<requirementTypes.Requirement>(CHANNELS.requirementsAnswer, id, answers),
    plan: (id: string, answers?: requirementTypes.RequirementAnswers, choice?: requirementTypes.CourseChoice) =>
      invoke<requirementTypes.Requirement>(CHANNELS.requirementsPlan, id, answers, choice),
    publish: (id: string) => invoke<requirementTypes.Requirement>(CHANNELS.requirementsPublish, id),
    remove: (id: string) => invoke<true>(CHANNELS.requirementsRemove, id),
    cancel: (id: string) => invoke<boolean>(CHANNELS.requirementsCancel, id),
    coursePath: (id: string, path: PathEntry[]) => invoke<requirementTypes.Requirement>(CHANNELS.requirementsCoursePath, id, path),
    courseSaveDraft: (id: string, pack: CoursePack) => invoke<requirementTypes.CourseDraftSaved>(CHANNELS.requirementsCourseSaveDraft, id, pack),
    courseConfirmDraft: (id: string, contentHash: string) => invoke<requirementTypes.Requirement>(CHANNELS.requirementsCourseConfirmDraft, id, contentHash),
    // What generating the first lab covers and roughly costs; nothing runs.
    labEstimate: (id: string) => invoke<requirementTypes.LabEstimate>(CHANNELS.requirementsLabEstimate, id),
    // Starts generating the first lab after the learner saw the estimate.
    labGenerate: (id: string) => invoke<requirementTypes.Requirement>(CHANNELS.requirementsLabGenerate, id),
  },

  agent: {
    status: () => invoke<settingsTypes.AgentStatus>(CHANNELS.agentStatus),
    runtimes: () => invoke<agentRuntimeTypes.AgentRuntimeStatus[]>(CHANNELS.agentRuntimes),
    models: (request: agentRuntimeTypes.CliModelsRequest) => invoke<agentRuntimeTypes.CliModelCatalog>(CHANNELS.agentModels, request),
  },
  coding: {
    status: () => invoke<codingTypes.CodingRuntimeStatus>(CHANNELS.codingStatus),
    start: (id: string, input: codingTypes.CodingStart) => invoke<packageTypes.TaskView>(CHANNELS.codingStart, id, input),
    get: (id: string) => invoke<packageTypes.TaskView>(CHANNELS.codingGet, id),
    events: (id: string, after: number) => invoke<codingTypes.CodingEventPage>(CHANNELS.codingEvents, id, after),
    cancel: (id: string) => invoke<boolean>(CHANNELS.codingCancel, id),
    patch: (id: string) => invoke<codingTypes.CodingPatchPreview>(CHANNELS.codingPatch, id),
    apply: (id: string, input: codingTypes.CodingApply) => invoke<codingTypes.CodingApplyResult>(CHANNELS.codingApply, id, input),
    resume: (id: string) => invoke<packageTypes.TaskView>(CHANNELS.codingResume, id),
    active: () => invoke<codingTypes.CodingActiveRun[]>(CHANNELS.codingActive),
  },

  activity: {
    overview: () => invoke<activityTypes.ActivityOverview>(CHANNELS.activityOverview),
    page: (before: string | null) => invoke<activityTypes.ActivityPage>(CHANNELS.activityPage, before),
  },

  costs: {
    report: (days: activityTypes.CostRange) => invoke<activityTypes.CostReport>(CHANNELS.costsReport, days),
    // The one outbound request: downloads the models.dev price list.
    syncPrices: () => invoke<{ syncedAt: string }>(CHANNELS.costsSyncPrices),
  },

  engineeringMap: {
    get: () => invoke<activityTypes.EngineeringMap>(CHANNELS.engineeringMap),
  },

  env: {
    get: () => invoke<envTypes.EnvState>(CHANNELS.envGet),
    plan: (options?: envTypes.EnvPlanOptions) => invoke<envTypes.EnvState>(CHANNELS.envPlan, options),
    setAllowScripts: (allow: boolean) => invoke<envTypes.EnvState>(CHANNELS.envSetAllowScripts, allow),
    runStep: (stepId: string) => invoke<envTypes.EnvState>(CHANNELS.envRunStep, stepId),
    apply: (kinds: envTypes.ScriptKind[]) => invoke<envTypes.EnvApplyResult>(CHANNELS.envApply, kinds),
    cancel: () => invoke<boolean>(CHANNELS.envCancel),
  },

  release: {
    get: () => invoke<releaseTypes.ReleaseState>(CHANNELS.releaseGet),
    recentCommits: () => invoke<releaseTypes.ReleaseCommit[]>(CHANNELS.releaseRecentCommits),
    generate: (startCommit?: string) => invoke<releaseTypes.ReleaseState>(CHANNELS.releaseGenerate, startCommit),
    updateDraft: (input: releaseTypes.ReleaseDraftInput) => invoke<releaseTypes.ReleaseState>(CHANNELS.releaseUpdateDraft, input),
    finish: () => invoke<releaseTypes.Release>(CHANNELS.releaseFinish),
    writeNotes: (input: releaseTypes.ReleaseWriteInput) => invoke<releaseTypes.ReleaseWriteResult>(CHANNELS.releaseWriteNotes, input),
    cancel: () => invoke<boolean>(CHANNELS.releaseCancel),
    createMilestone: (input: releaseTypes.MilestoneInput) => invoke<releaseTypes.ReleaseState>(CHANNELS.milestoneCreate, input),
    updateMilestone: (id: string, input: releaseTypes.MilestoneInput) => invoke<releaseTypes.ReleaseState>(CHANNELS.milestoneUpdate, id, input),
    deleteMilestone: (id: string) => invoke<releaseTypes.ReleaseState>(CHANNELS.milestoneDelete, id),
    assignMilestone: (requirementId: string, milestoneId: string | null) =>
      invoke<releaseTypes.ReleaseState>(CHANNELS.milestoneAssign, requirementId, milestoneId),
  },

  repositories: {
    list: () => invoke<repositoryTypes.RepositoryList>(CHANNELS.repositoriesList),
    // Validates and registers a root; `open` also switches to it.
    add: (root: string, open: boolean) => invoke<repositoryTypes.RepositoryList>(CHANNELS.repositoriesAdd, root, open),
    // Cancels running work first; ask with busy() before calling.
    switch: (id: string) => invoke<repositoryTypes.RepositoryList>(CHANNELS.repositoriesSwitch, id),
    relocate: (id: string, root: string) => invoke<repositoryTypes.RepositoryList>(CHANNELS.repositoriesRelocate, id, root),
    busy: () => invoke<repositoryTypes.BusyRun[]>(CHANNELS.repositoriesBusy),
  },

  commit: {
    preview: (id: string) => invoke<commitTypes.CommitPreview>(CHANNELS.commitPreview, id),
    // `files` is the list the developer reviewed; a changed list is refused.
    create: (id: string, message: string, files: string[]) => invoke<commitTypes.CommitResult>(CHANNELS.commitCreate, id, message, files),
  },

  tutor: {
    get: (id: string, stepIndex: number) => invoke<tutorTypes.TutorState>(CHANNELS.tutorGet, id, stepIndex),
    // Starts Tutor in the background; poll get() for the answer.
    ask: (id: string, stepIndex: number) => invoke<tutorTypes.TutorState>(CHANNELS.tutorAsk, id, stepIndex),
    cancel: (id: string, stepIndex: number) => invoke<boolean>(CHANNELS.tutorCancel, id, stepIndex),
  },

  practice: {
    // The reference patch; refused until the package was first submitted.
    reference: (id: string) => invoke<string>(CHANNELS.referenceGet, id),
    // Grades now: a retry, or without waiting for the reference.
    grade: (id: string, skipReference: boolean) => invoke<packageTypes.TaskView>(CHANNELS.gradeStart, id, skipReference),
  },

  notes: {
    // Every note without its body; `since` returns null when nothing changed.
    list: (since: number | null) => invoke<noteTypes.NoteList | null>(CHANNELS.notesList, since),
    get: (id: string) => invoke<noteTypes.Note>(CHANNELS.notesGet, id),
    // Ids of notes whose title, tags or body contain the query.
    search: (query: string) => invoke<string[]>(CHANNELS.notesSearch, query),
    // autoRename: a taken title gets a number instead of being refused.
    create: (input: noteTypes.NoteInput, autoRename: boolean) => invoke<noteTypes.NoteSaved>(CHANNELS.notesCreate, input, autoRename),
    // The source stays as recorded; only the developer's text changes.
    update: (id: string, edit: noteTypes.NoteEdit) => invoke<noteTypes.NoteSaved>(CHANNELS.notesUpdate, id, edit),
    // Moves the file to the system trash.
    remove: (id: string) => invoke<boolean>(CHANNELS.notesDelete, id),
    // Tutor writes the note's summary (costs a model call).
    summarize: (id: string, baseVersion: string) => invoke<noteTypes.NoteSaved>(CHANNELS.notesSummarize, id, baseVersion),
    // null goes back to the default folder; files are never moved.
    setDirectory: (directory: string | null) => invoke<noteTypes.NoteList>(CHANNELS.notesSetDirectory, directory),
    pickDirectory: () => invoke<string | null>(CHANNELS.notesPickDirectory),
    reveal: () => invoke<boolean>(CHANNELS.notesReveal),
    // http(s) and mailto links only, opened by the system.
    openUrl: (url: string) => invoke<boolean>(CHANNELS.notesOpenUrl, url),
    // The packs whose categories the notes page names, and the one in use.
    courses: () => invoke<noteTypes.NoteCourses>(CHANNELS.notesCourses),
  },

  courses: {
    list: () => invoke<courseTypes.CourseList>(CHANNELS.coursesList),
    preview: (id: string) => invoke<courseTypes.CoursePreview>(CHANNELS.coursesPreview, id),
    // Writes this machine's choice; null leaves it to taskpilot.toml.
    select: (id: string | null) => invoke<courseTypes.CourseList>(CHANNELS.coursesSelect, id),
    // Opens the file picker and validates the file; nothing is copied yet.
    pickImport: () => invoke<courseTypes.CourseImport | null>(CHANNELS.coursesPickImport),
    // Copies the picked file, the content with the hash shown, into the global folder.
    import: (contentHash: string) => invoke<courseTypes.CourseList>(CHANNELS.coursesImport, contentHash),
    // The built-in default pack, for records from before packs.
    default: () => invoke<CoursePack>(CHANNELS.coursesDefault),
    // Copies a pack into the global folder as `id`; the copy needs confirming.
    copy: (sourceId: string, id: string) => invoke<courseTypes.CourseSaved>(CHANNELS.coursesCopy, sourceId, id),
    // Saves an imported or copied pack from the editor; it needs confirming again.
    save: (id: string, pack: CoursePack) => invoke<courseTypes.CourseSaved>(CHANNELS.coursesSave, id, pack),
  },
};

export type TaskPilotApi = typeof api;

contextBridge.exposeInMainWorld('taskpilot', api);
