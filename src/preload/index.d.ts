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
declare const api: {
  businessTimeZone: string;
  onFullScreen: (listener: (fullScreen: boolean) => void) => void;
  startupReady: (retry: boolean) => Promise<envelopeTypes.IpcResult<boolean>>;
  listTasks: () => Promise<envelopeTypes.IpcResult<packageTypes.TaskView[]>>;
  getTask: (id: string) => Promise<envelopeTypes.IpcResult<packageTypes.TaskView>>;
  transition: (
    id: string,
    name: packageTypes.HumanTransition,
    options?: packageTypes.TransitionOptions,
  ) => Promise<envelopeTypes.IpcResult<packageTypes.WorkPackageState>>;
  waiveDependency: (id: string, dependency: string) => Promise<envelopeTypes.IpcResult<packageTypes.TaskView>>;
  measureBaseline: (id: string) => Promise<envelopeTypes.IpcResult<packageTypes.TaskView>>;
  setStepDone: (id: string, stepIndex: number, done: boolean) => Promise<envelopeTypes.IpcResult<packageTypes.WorkPackageState>>;
  review: {
    retry: (id: string) => Promise<envelopeTypes.IpcResult<packageTypes.WorkPackageState>>;
    cancel: (id: string) => Promise<envelopeTypes.IpcResult<boolean>>;
  };
  deviation: {
    retry: (id: string) => Promise<envelopeTypes.IpcResult<packageTypes.WorkPackageState>>;
    cancel: (id: string) => Promise<envelopeTypes.IpcResult<boolean>>;
  };
  workspace: {
    get: () => Promise<envelopeTypes.IpcResult<workspaceTypes.WorkspaceView>>;
    set: (form: workspaceTypes.WorkspaceForm) => Promise<envelopeTypes.IpcResult<workspaceTypes.WorkspaceView>>;
    check: (form: workspaceTypes.WorkspaceForm) => Promise<envelopeTypes.IpcResult<workspaceTypes.WorkspaceCheck>>;
    pickRoot: () => Promise<envelopeTypes.IpcResult<string | null>>;
    info: () => Promise<envelopeTypes.IpcResult<workspaceTypes.WorkspaceInfo>>;
    createProject: (preset: string) => Promise<envelopeTypes.IpcResult<workspaceTypes.WorkspaceView>>;
    confirmCourse: (id: string, contentHash: string) => Promise<envelopeTypes.IpcResult<workspaceTypes.WorkspaceView>>;
    openFile: (filePath: string, line?: number | null) => Promise<envelopeTypes.IpcResult<workspaceTypes.OpenedWith>>;
  };
  diff: {
    stat: (id: string) => Promise<envelopeTypes.IpcResult<workspaceTypes.DiffStat>>;
    file: (id: string, filePath: string) => Promise<envelopeTypes.IpcResult<string>>;
  };
  verify: {
    run: (kind: workspaceTypes.CheckKind, taskId?: string) => Promise<envelopeTypes.IpcResult<workspaceTypes.VerifyRun>>;
  };
  preferences: {
    get: () => Promise<envelopeTypes.IpcResult<settingsTypes.Preferences>>;
    set: (prefs: settingsTypes.PreferencesInput) => Promise<envelopeTypes.IpcResult<settingsTypes.Preferences>>;
  };
  environment: {
    info: (options?: settingsTypes.EnvironmentInfoOptions) => Promise<envelopeTypes.IpcResult<settingsTypes.EnvironmentInfo>>;
  };
  data: {
    info: () => Promise<envelopeTypes.IpcResult<settingsTypes.DataInfo>>;
    resetProgress: () => Promise<envelopeTypes.IpcResult<settingsTypes.PackageSummary>>;
    reveal: () => Promise<envelopeTypes.IpcResult<true>>;
  };
  requirements: {
    list: () => Promise<envelopeTypes.IpcResult<requirementTypes.Requirement[]>>;
    get: (id: string) => Promise<envelopeTypes.IpcResult<requirementTypes.Requirement>>;
    create: (input: requirementTypes.RequirementInput) => Promise<envelopeTypes.IpcResult<requirementTypes.Requirement>>;
    clarify: (id: string) => Promise<envelopeTypes.IpcResult<requirementTypes.Requirement>>;
    answer: (id: string, answers: requirementTypes.RequirementAnswers) => Promise<envelopeTypes.IpcResult<requirementTypes.Requirement>>;
    plan: (
      id: string,
      answers?: requirementTypes.RequirementAnswers,
      choice?: requirementTypes.CourseChoice,
    ) => Promise<envelopeTypes.IpcResult<requirementTypes.Requirement>>;
    publish: (id: string) => Promise<envelopeTypes.IpcResult<requirementTypes.Requirement>>;
    remove: (id: string) => Promise<envelopeTypes.IpcResult<true>>;
    cancel: (id: string) => Promise<envelopeTypes.IpcResult<boolean>>;
    coursePath: (id: string, path: PathEntry[]) => Promise<envelopeTypes.IpcResult<requirementTypes.Requirement>>;
    courseSaveDraft: (id: string, pack: CoursePack) => Promise<envelopeTypes.IpcResult<requirementTypes.CourseDraftSaved>>;
    courseConfirmDraft: (id: string, contentHash: string) => Promise<envelopeTypes.IpcResult<requirementTypes.Requirement>>;
    labEstimate: (id: string, conceptId?: string) => Promise<envelopeTypes.IpcResult<requirementTypes.LabEstimate>>;
    labGenerate: (id: string, conceptId?: string) => Promise<envelopeTypes.IpcResult<requirementTypes.Requirement>>;
  };
  agent: {
    status: () => Promise<envelopeTypes.IpcResult<settingsTypes.AgentStatus>>;
    runtimes: () => Promise<envelopeTypes.IpcResult<agentRuntimeTypes.AgentRuntimeStatus[]>>;
    models: (request: agentRuntimeTypes.CliModelsRequest) => Promise<envelopeTypes.IpcResult<agentRuntimeTypes.CliModelCatalog>>;
  };
  coding: {
    status: () => Promise<envelopeTypes.IpcResult<codingTypes.CodingRuntimeStatus>>;
    start: (id: string, input: codingTypes.CodingStart) => Promise<envelopeTypes.IpcResult<packageTypes.TaskView>>;
    get: (id: string) => Promise<envelopeTypes.IpcResult<packageTypes.TaskView>>;
    events: (id: string, after: number) => Promise<envelopeTypes.IpcResult<codingTypes.CodingEventPage>>;
    cancel: (id: string) => Promise<envelopeTypes.IpcResult<boolean>>;
    patch: (id: string) => Promise<envelopeTypes.IpcResult<codingTypes.CodingPatchPreview>>;
    apply: (id: string, input: codingTypes.CodingApply) => Promise<envelopeTypes.IpcResult<codingTypes.CodingApplyResult>>;
    resume: (id: string) => Promise<envelopeTypes.IpcResult<packageTypes.TaskView>>;
    active: () => Promise<envelopeTypes.IpcResult<codingTypes.CodingActiveRun[]>>;
  };
  activity: {
    overview: () => Promise<envelopeTypes.IpcResult<activityTypes.ActivityOverview>>;
    page: (before: string | null) => Promise<envelopeTypes.IpcResult<activityTypes.ActivityPage>>;
  };
  costs: {
    report: (days: activityTypes.CostRange) => Promise<envelopeTypes.IpcResult<activityTypes.CostReport>>;
    syncPrices: () => Promise<envelopeTypes.IpcResult<{ syncedAt: string }>>;
  };
  engineeringMap: {
    get: () => Promise<envelopeTypes.IpcResult<activityTypes.EngineeringMap>>;
  };
  env: {
    get: () => Promise<envelopeTypes.IpcResult<envTypes.EnvState>>;
    plan: (options?: envTypes.EnvPlanOptions) => Promise<envelopeTypes.IpcResult<envTypes.EnvState>>;
    setAllowScripts: (allow: boolean) => Promise<envelopeTypes.IpcResult<envTypes.EnvState>>;
    runStep: (stepId: string) => Promise<envelopeTypes.IpcResult<envTypes.EnvState>>;
    apply: (kinds: envTypes.ScriptKind[]) => Promise<envelopeTypes.IpcResult<envTypes.EnvState>>;
    cancel: () => Promise<envelopeTypes.IpcResult<boolean>>;
  };
  release: {
    get: () => Promise<envelopeTypes.IpcResult<releaseTypes.ReleaseState>>;
    recentCommits: () => Promise<envelopeTypes.IpcResult<releaseTypes.ReleaseCommit[]>>;
    generate: (startCommit?: string) => Promise<envelopeTypes.IpcResult<releaseTypes.ReleaseState>>;
    updateDraft: (input: releaseTypes.ReleaseDraftInput) => Promise<envelopeTypes.IpcResult<releaseTypes.ReleaseState>>;
    finish: () => Promise<envelopeTypes.IpcResult<releaseTypes.Release>>;
    writeNotes: (input: releaseTypes.ReleaseWriteInput) => Promise<envelopeTypes.IpcResult<releaseTypes.ReleaseWriteResult>>;
    cancel: () => Promise<envelopeTypes.IpcResult<boolean>>;
    createMilestone: (input: releaseTypes.MilestoneInput) => Promise<envelopeTypes.IpcResult<releaseTypes.ReleaseState>>;
    updateMilestone: (id: string, input: releaseTypes.MilestoneInput) => Promise<envelopeTypes.IpcResult<releaseTypes.ReleaseState>>;
    deleteMilestone: (id: string) => Promise<envelopeTypes.IpcResult<releaseTypes.ReleaseState>>;
    assignMilestone: (requirementId: string, milestoneId: string | null) => Promise<envelopeTypes.IpcResult<releaseTypes.ReleaseState>>;
  };
  repositories: {
    list: () => Promise<envelopeTypes.IpcResult<repositoryTypes.RepositoryList>>;
    add: (root: string, open: boolean) => Promise<envelopeTypes.IpcResult<repositoryTypes.RepositoryList>>;
    switch: (id: string) => Promise<envelopeTypes.IpcResult<repositoryTypes.RepositoryList>>;
    relocate: (id: string, root: string) => Promise<envelopeTypes.IpcResult<repositoryTypes.RepositoryList>>;
    busy: () => Promise<envelopeTypes.IpcResult<repositoryTypes.BusyRun[]>>;
  };
  commit: {
    preview: (id: string) => Promise<envelopeTypes.IpcResult<commitTypes.CommitPreview>>;
    create: (id: string, message: string, files: string[]) => Promise<envelopeTypes.IpcResult<commitTypes.CommitResult>>;
  };
  tutor: {
    get: (id: string, stepIndex: number) => Promise<envelopeTypes.IpcResult<tutorTypes.TutorState>>;
    ask: (id: string, stepIndex: number) => Promise<envelopeTypes.IpcResult<tutorTypes.TutorState>>;
    cancel: (id: string, stepIndex: number) => Promise<envelopeTypes.IpcResult<boolean>>;
  };
  practice: {
    reference: (id: string) => Promise<envelopeTypes.IpcResult<string>>;
    grade: (id: string, skipReference: boolean) => Promise<envelopeTypes.IpcResult<packageTypes.TaskView>>;
  };
  notes: {
    list: (since: number | null) => Promise<envelopeTypes.IpcResult<noteTypes.NoteList | null>>;
    get: (id: string) => Promise<envelopeTypes.IpcResult<noteTypes.Note>>;
    search: (query: string) => Promise<envelopeTypes.IpcResult<string[]>>;
    create: (input: noteTypes.NoteInput, autoRename: boolean) => Promise<envelopeTypes.IpcResult<noteTypes.NoteSaved>>;
    update: (id: string, edit: noteTypes.NoteEdit) => Promise<envelopeTypes.IpcResult<noteTypes.NoteSaved>>;
    remove: (id: string) => Promise<envelopeTypes.IpcResult<boolean>>;
    summarize: (id: string, baseVersion: string) => Promise<envelopeTypes.IpcResult<noteTypes.NoteSaved>>;
    setDirectory: (directory: string | null) => Promise<envelopeTypes.IpcResult<noteTypes.NoteList>>;
    pickDirectory: () => Promise<envelopeTypes.IpcResult<string | null>>;
    reveal: () => Promise<envelopeTypes.IpcResult<boolean>>;
    openUrl: (url: string) => Promise<envelopeTypes.IpcResult<boolean>>;
    courses: () => Promise<envelopeTypes.IpcResult<noteTypes.NoteCourses>>;
  };
  courses: {
    list: () => Promise<envelopeTypes.IpcResult<courseTypes.CourseList>>;
    preview: (id: string) => Promise<envelopeTypes.IpcResult<courseTypes.CoursePreview>>;
    select: (id: string | null) => Promise<envelopeTypes.IpcResult<courseTypes.CourseList>>;
    pickImport: () => Promise<envelopeTypes.IpcResult<courseTypes.CourseImport | null>>;
    import: (contentHash: string) => Promise<envelopeTypes.IpcResult<courseTypes.CourseList>>;
    default: () => Promise<envelopeTypes.IpcResult<CoursePack>>;
    copy: (sourceId: string, id: string) => Promise<envelopeTypes.IpcResult<courseTypes.CourseSaved>>;
    save: (id: string, pack: CoursePack) => Promise<envelopeTypes.IpcResult<courseTypes.CourseSaved>>;
  };
};

export type TaskPilotApi = typeof api;

declare global {
  interface Window {
    taskpilot: TaskPilotApi;
  }
}

export {};
