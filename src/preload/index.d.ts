import type * as ipc from '../shared/ipc_types.ts';
declare const api: {
  businessTimeZone: string;
  listTasks: () => Promise<ipc.IpcResult<ipc.TaskView[]>>;
  getTask: (id: string) => Promise<ipc.IpcResult<ipc.TaskView>>;
  transition: (id: string, name: ipc.HumanTransition, options?: ipc.TransitionOptions) => Promise<ipc.IpcResult<ipc.WorkPackageState>>;
  waiveDependency: (id: string, dependency: string) => Promise<ipc.IpcResult<ipc.TaskView>>;
  measureBaseline: (id: string) => Promise<ipc.IpcResult<ipc.TaskView>>;
  setStepDone: (id: string, stepIndex: number, done: boolean) => Promise<ipc.IpcResult<ipc.WorkPackageState>>;
  review: {
    retry: (id: string) => Promise<ipc.IpcResult<ipc.WorkPackageState>>;
    cancel: (id: string) => Promise<ipc.IpcResult<boolean>>;
  };
  deviation: {
    retry: (id: string) => Promise<ipc.IpcResult<ipc.WorkPackageState>>;
    cancel: (id: string) => Promise<ipc.IpcResult<boolean>>;
  };
  workspace: {
    get: () => Promise<ipc.IpcResult<ipc.WorkspaceView>>;
    set: (form: ipc.WorkspaceForm) => Promise<ipc.IpcResult<ipc.WorkspaceView>>;
    check: (form: ipc.WorkspaceForm) => Promise<ipc.IpcResult<ipc.WorkspaceCheck>>;
    pickRoot: () => Promise<ipc.IpcResult<string | null>>;
    info: () => Promise<ipc.IpcResult<ipc.WorkspaceInfo>>;
    openFile: (filePath: string, line?: number | null) => Promise<ipc.IpcResult<ipc.OpenedWith>>;
  };
  diff: {
    stat: (id: string) => Promise<ipc.IpcResult<ipc.DiffStat>>;
    file: (id: string, filePath: string) => Promise<ipc.IpcResult<string>>;
  };
  verify: {
    run: (kind: ipc.CheckKind, taskId?: string) => Promise<ipc.IpcResult<ipc.VerifyRun>>;
  };
  preferences: {
    get: () => Promise<ipc.IpcResult<ipc.Preferences>>;
    set: (prefs: ipc.PreferencesInput) => Promise<ipc.IpcResult<ipc.Preferences>>;
  };
  environment: {
    info: (options?: ipc.EnvironmentInfoOptions) => Promise<ipc.IpcResult<ipc.EnvironmentInfo>>;
  };
  data: {
    info: () => Promise<ipc.IpcResult<ipc.DataInfo>>;
    resetProgress: () => Promise<ipc.IpcResult<ipc.PackageSummary>>;
    reveal: () => Promise<ipc.IpcResult<true>>;
  };
  requirements: {
    list: () => Promise<ipc.IpcResult<ipc.Requirement[]>>;
    get: (id: string) => Promise<ipc.IpcResult<ipc.Requirement>>;
    create: (input: ipc.RequirementInput) => Promise<ipc.IpcResult<ipc.Requirement>>;
    clarify: (id: string) => Promise<ipc.IpcResult<ipc.Requirement>>;
    answer: (id: string, answers: ipc.RequirementAnswers) => Promise<ipc.IpcResult<ipc.Requirement>>;
    plan: (id: string, answers?: ipc.RequirementAnswers) => Promise<ipc.IpcResult<ipc.Requirement>>;
    publish: (id: string) => Promise<ipc.IpcResult<ipc.Requirement>>;
    remove: (id: string) => Promise<ipc.IpcResult<true>>;
    cancel: (id: string) => Promise<ipc.IpcResult<boolean>>;
  };
  agent: {
    status: () => Promise<ipc.IpcResult<ipc.AgentStatus>>;
    runtimes: () => Promise<ipc.IpcResult<ipc.AgentRuntimeStatus[]>>;
    models: (request: ipc.CliModelsRequest) => Promise<ipc.IpcResult<ipc.CliModelCatalog>>;
  };
  coding: {
    status: () => Promise<ipc.IpcResult<ipc.CodingRuntimeStatus>>;
    start: (id: string, input: ipc.CodingStart) => Promise<ipc.IpcResult<ipc.TaskView>>;
    get: (id: string) => Promise<ipc.IpcResult<ipc.TaskView>>;
    events: (id: string, after: number) => Promise<ipc.IpcResult<ipc.CodingEventPage>>;
    cancel: (id: string) => Promise<ipc.IpcResult<boolean>>;
    patch: (id: string) => Promise<ipc.IpcResult<ipc.CodingPatchPreview>>;
    apply: (id: string, input: ipc.CodingApply) => Promise<ipc.IpcResult<ipc.CodingApplyResult>>;
    active: () => Promise<ipc.IpcResult<ipc.CodingActiveRun[]>>;
  };
  activity: {
    overview: () => Promise<ipc.IpcResult<ipc.ActivityOverview>>;
    page: (before: string | null) => Promise<ipc.IpcResult<ipc.ActivityPage>>;
  };
  costs: {
    report: (days: ipc.CostRange) => Promise<ipc.IpcResult<ipc.CostReport>>;
    syncPrices: () => Promise<ipc.IpcResult<{ syncedAt: string }>>;
  };
  engineeringMap: {
    get: () => Promise<ipc.IpcResult<ipc.EngineeringMap>>;
  };
  env: {
    get: () => Promise<ipc.IpcResult<ipc.EnvState>>;
    plan: (options?: ipc.EnvPlanOptions) => Promise<ipc.IpcResult<ipc.EnvState>>;
    setAllowScripts: (allow: boolean) => Promise<ipc.IpcResult<ipc.EnvState>>;
    runStep: (stepId: string) => Promise<ipc.IpcResult<ipc.EnvState>>;
    apply: (kinds: ipc.ScriptKind[]) => Promise<ipc.IpcResult<ipc.EnvState>>;
    cancel: () => Promise<ipc.IpcResult<boolean>>;
  };
  release: {
    get: () => Promise<ipc.IpcResult<ipc.ReleaseState>>;
    recentCommits: () => Promise<ipc.IpcResult<ipc.ReleaseCommit[]>>;
    generate: (startCommit?: string) => Promise<ipc.IpcResult<ipc.ReleaseState>>;
    updateDraft: (input: ipc.ReleaseDraftInput) => Promise<ipc.IpcResult<ipc.ReleaseState>>;
    finish: () => Promise<ipc.IpcResult<ipc.Release>>;
    writeNotes: (input: ipc.ReleaseWriteInput) => Promise<ipc.IpcResult<ipc.ReleaseWriteResult>>;
    cancel: () => Promise<ipc.IpcResult<boolean>>;
    createMilestone: (input: ipc.MilestoneInput) => Promise<ipc.IpcResult<ipc.ReleaseState>>;
    updateMilestone: (id: string, input: ipc.MilestoneInput) => Promise<ipc.IpcResult<ipc.ReleaseState>>;
    deleteMilestone: (id: string) => Promise<ipc.IpcResult<ipc.ReleaseState>>;
    assignMilestone: (requirementId: string, milestoneId: string | null) => Promise<ipc.IpcResult<ipc.ReleaseState>>;
  };
  repositories: {
    list: () => Promise<ipc.IpcResult<ipc.RepositoryList>>;
    add: (root: string, open: boolean) => Promise<ipc.IpcResult<ipc.RepositoryList>>;
    switch: (id: string) => Promise<ipc.IpcResult<ipc.RepositoryList>>;
    relocate: (id: string, root: string) => Promise<ipc.IpcResult<ipc.RepositoryList>>;
    busy: () => Promise<ipc.IpcResult<ipc.BusyRun[]>>;
  };
  commit: {
    preview: (id: string) => Promise<ipc.IpcResult<ipc.CommitPreview>>;
    create: (id: string, message: string, files: string[]) => Promise<ipc.IpcResult<ipc.CommitResult>>;
  };
  tutor: {
    get: (id: string, stepIndex: number) => Promise<ipc.IpcResult<ipc.TutorState>>;
    ask: (id: string, stepIndex: number) => Promise<ipc.IpcResult<ipc.TutorState>>;
    cancel: (id: string, stepIndex: number) => Promise<ipc.IpcResult<boolean>>;
  };
};

export type TaskPilotApi = typeof api;

declare global {
  interface Window {
    taskpilot: TaskPilotApi;
  }
}

export {};
