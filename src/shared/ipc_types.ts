// The wire contract between the main process and the renderer: every shape
// that crosses IPC, as plain structural types. Nothing here imports from
// src/main, because the renderer typechecks without it; src/main/ipc.ts
// annotates its handlers with these types so drift fails tsc.

// ========== envelope ==========

// Shaped like an Error but safe to send over IPC. `field` names the form
// input at fault, when there is one.
export type IpcFailure = { code: string; message: string; field?: string };

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: IpcFailure };

// Error recorded on an agent run or a resolved PATH.
export type ErrorInfo = { code: string; message: string };

// ========== work packages ==========

export type WorkPackageStatus = 'clarifying' | 'pending' | 'in_progress' | 'in_review' | 'deviation' | 'accepting' | 'done' | 'blocked';

// Transitions the renderer may request; the actor is always 'human'.
export type HumanTransition =
  | 'claim' | 'revert_replan' | 'release' | 'submit_for_review' | 'report_deviation'
  | 'override_dismissal' | 'block' | 'accepted' | 'acceptance_rejected' | 'unblock';

export type AgentTransition = 'breakdown_done' | 'review_accepted' | 'review_passed' | 'review_rejected' | 'replanned' | 'deviation_dismissed';

export type Priority = 'high' | 'medium' | 'low';

// `test` links a criterion to a test name; without it the criterion is manual.
export type AcceptanceCriterion = { text: string; test?: string };

// A work package definition: hand-written samples and published packages.
export type TaskDefinition = {
  id: string;
  status: WorkPackageStatus;
  title: string;
  description: string;
  intro: string;
  module: string;
  tags: string[];
  priority: Priority;
  estimate: string;
  icon: string;
  // Inline code is marked with backticks.
  steps: string[];
  fileScope: string[];
  acceptance: AcceptanceCriterion[];
  // Set on packages generated from a requirement.
  requirementId?: string;
};

// The parts of a definition Architect's replan replaces.
export type RevisionDefinition = { steps: string[]; fileScope: string[]; acceptance: AcceptanceCriterion[] };

export type DeviationResolution = {
  decision: 'dismiss' | 'replan';
  reason: string;
  changes: string[];
  decidedAt: string;
  // A replan that answered a contested dismissal.
  afterContest: boolean;
  // The developer contested this dismissal (override_dismissal).
  contested: boolean;
  // The human reverted this replan (revert_replan).
  reverted: boolean;
};

export type Deviation = {
  note: string;
  stepIndex: number | null;
  filePath: string | null;
  reportedAt: string;
  resolution: DeviationResolution | null;
};

// What the renderer sends with report_deviation.
export type DeviationInput = { note: string; stepIndex?: number | null; filePath?: string | null };

export type TransitionOptions = { deviation?: DeviationInput };

// ========== checks and evidence ==========

export type CheckKind = 'test' | 'lint' | 'build' | 'smoke';
export type CheckStage = 'step' | 'submit';

// One parsed test result; `fullName` is the key baselines compare by.
export type TestResult = { name: string; fullName?: string; passed: boolean; skipped: boolean; todo: boolean };

export type RunSummary = { total: number; passed: number; failed: number; skipped: number; ok: boolean };

export type ReportProblem = 'missing' | 'stale' | 'not_a_file' | 'outside' | 'too_large' | 'invalid';

export type ReportInfo = { format: 'stdout' | 'junit'; trusted: boolean; problem: ReportProblem | null };

// verification.runCheck(): one run of a configured check.
export type CheckRun = {
  kind: CheckKind;
  command: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  output: string;
  results: TestResult[];
  summary: RunSummary;
  report: ReportInfo;
  check: { stage: CheckStage; blocking: boolean };
};

// What a stored review keeps of a run (qa.compactRun()).
export type CompactRun =
  | { error: ErrorInfo }
  | {
    kind: CheckKind;
    command: string;
    exitCode: number;
    timedOut: boolean;
    durationMs: number;
    summary: RunSummary;
    report: ReportInfo | null;
    failing: string[];
    outputTail: string | null;
  };

export type EvidenceStatus = 'pass' | 'fail' | 'unverifiable' | 'skipped';

// Reason codes are open-ended (report_<problem>, error codes), so plain strings.
export type Evidence = {
  kind: CheckKind;
  stage: CheckStage;
  blocking: boolean;
  baseline: 'measured' | 'none';
  status: EvidenceStatus;
  reason: string | null;
  newFailures: string[];
  preexisting: string[];
  fixed: string[];
};

export type CriterionStatus = 'verified' | 'failed' | 'missing' | 'unverifiable' | 'manual';

// evidence.criteriaStatus(); verified/manual/missing are the legacy flags.
export type CriterionEvidence = AcceptanceCriterion & {
  status: CriterionStatus;
  verified: boolean;
  manual: boolean;
  missing?: boolean;
  alreadyPassing?: boolean;
};

export type AttentionItem =
  | { code: 'check_unverifiable'; kind: CheckKind; reason: string | null; blocking: boolean }
  | { code: 'preexisting_failures'; kind: CheckKind; count: number }
  | { code: 'no_baseline'; kind: CheckKind }
  | { code: 'criterion_unverifiable' | 'criterion_manual' | 'criterion_already_passing'; index: number };

// evidence.baselineRecord(), or why a check has none.
export type BaselineCheckRecord =
  | {
    status: 'measured';
    line: string;
    exitCode: number;
    timedOut: boolean;
    crashed: boolean;
    reportProblem: ReportProblem | null;
    failing: string[];
    passing: string[];
    at: string;
  }
  | { status: 'unavailable'; reason: string; line: string };

export type BaselineStatus = 'measuring' | 'measured' | 'unavailable' | 'contaminated';

// Reasons: no_checks | head_moved | dirty_tree | cancelled | interrupted |
// tree_changed, or an error code.
export type BaselineChecks = {
  status: BaselineStatus;
  reason: string | null;
  commit: string;
  checks: Partial<Record<CheckKind, BaselineCheckRecord>>;
  startedAt: string;
  finishedAt: string | null;
};

// verify:run with a task id adds the same comparison a review makes.
export type VerifyRun = CheckRun & { evidence?: Evidence; acceptance?: CriterionEvidence[] };

// ========== QA review ==========

export type ReviewReason = 'no_changes' | 'tests_failed' | 'acceptance_tests' | 'qa_rejected' | 'blocker' | 'criteria_unmet';

export type QaReport = {
  verdict: 'pass' | 'reject';
  summary: string;
  criteria: { index: number; status: 'met' | 'unmet' | 'unclear'; note: string | null }[];
  issues: { severity: 'blocker' | 'major' | 'minor'; text: string; file: string | null; line: number | null }[];
};

export type DiffSkipReason = 'rename' | 'outside_workspace' | 'secret' | 'binary' | 'file_limit' | 'unreadable' | 'too_large' | 'budget';

export type ReviewDiff = {
  files: { path: string; bytes: number; untracked: boolean }[];
  skipped: { path: string; reason: DiffSkipReason }[];
  outOfScope: string[];
};

export type ReviewCheck = Evidence & { run: CompactRun | null };

type ReviewTiming = { startedAt: string; finishedAt: string | null };

export type Review =
  | (ReviewTiming & { status: 'running'; error: null })
  // The running entry plus why it could not finish.
  | (ReviewTiming & { status: 'failed'; error: ErrorInfo })
  | (ReviewTiming & {
    status: 'passed' | 'rejected';
    error: null;
    reasons: ReviewReason[];
    attention: AttentionItem[];
    checks: ReviewCheck[];
    // The unit-test run, as the execution page shows it.
    verification: CompactRun | null;
    acceptance: CriterionEvidence[];
    // Null when the outcome was certain without the model.
    report: QaReport | null;
    diff: ReviewDiff;
    costUsd: number;
    // Set when the human accepts or rejects QA's pass.
    humanVerdict?: 'accepted' | 'acceptance_rejected';
    humanAt?: string;
  });

// ========== Architect on a deviation ==========

// Why repo_reader did not read a file.
export type ReadSkipReason = 'not_tracked' | 'secret' | 'not_a_file' | 'file_limit' | 'too_large' | 'budget' | 'binary';

export type SkippedFile = { path: string; reason: ReadSkipReason };

type AdjudicationBase = { mustReplan: boolean; startedAt: string; finishedAt: string | null };

export type Adjudication =
  | (AdjudicationBase & { status: 'running'; error: null })
  | (AdjudicationBase & { status: 'failed'; error: ErrorInfo })
  | (AdjudicationBase & { status: 'done'; error: null; read: string[]; skipped: SkippedFile[]; costUsd: number });

export type Revision = {
  version: number;
  definition: RevisionDefinition;
  reason: string;
  changes: string[];
  revisedAt: string;
};

// ========== package state and views ==========

// Execution state from before a replan, kept until the new plan is claimed.
export type ReplanUndo = {
  revision: Revision | null;
  baseline: string | null;
  claimedAt: string | null;
  completedSteps: number[];
  baselineChecks: BaselineChecks | null;
  review: Review | null;
};

// WorkPackageStore state for one package. transition, setStepDone and the
// review/deviation retries return this, not a TaskView: reload with getTask.
export type WorkPackageState = {
  status: WorkPackageStatus;
  // Commit recorded when the human claimed the package.
  baseline: string | null;
  claimedAt: string | null;
  // Indices into the definition's steps.
  completedSteps: number[];
  deviations: Deviation[];
  review: Review | null;
  baselineChecks: BaselineChecks | null;
  revision: Revision | null;
  adjudication: Adjudication | null;
  replanUndo: ReplanUndo | null;
};

// The effective definition (Architect's replan laid over it) plus its state.
export type TaskView = TaskDefinition & {
  status: WorkPackageStatus;
  statusLabel: string;
  baseline: string | null;
  claimedAt: string | null;
  completedSteps: number[];
  deviations: Deviation[];
  review: Review | null;
  baselineChecks: BaselineChecks | null;
  adjudication: Adjudication | null;
  // Null when never replanned; the definition itself is already applied.
  revision: Omit<Revision, 'definition'> | null;
  // Human transitions available now, after the state guards.
  humanTransitions: HumanTransition[];
};

// ========== diff ==========

export type FileChange = { path: string; added: number; removed: number; binary: boolean; untracked: boolean };

export type FileScopeCheck = { inScope: string[]; outOfScope: string[]; untouched: string[] };

export type DiffStat = { changes: FileChange[]; scope: FileScopeCheck };

// A unified diff for one file.
export type DiffFile = string;

// ========== workspace ==========

export type CommandEntry = { command: string; args: string[] };

export type CheckReport = { format: 'stdout' } | { format: 'junit'; path: string };

export type WorkspaceCheckConfig = CommandEntry & {
  stage: CheckStage;
  blocking: boolean;
  report: CheckReport;
  env: Record<string, string>;
  timeoutMs?: number;
};

// Per-kind options the settings form edits; reportPath '' means stdout.
export type CheckOptions = { stage: CheckStage; blocking: boolean; reportPath: string };

// What the settings page sends to workspace:set and workspace:check. A blank
// command line means the kind is not configured.
export type WorkspaceForm = {
  root: string;
  commands: Partial<Record<CheckKind, string>>;
  options?: Partial<Record<CheckKind, Partial<CheckOptions>>>;
};

// The config plus the command lines and options the form edits.
export type WorkspaceView = {
  root: string | null;
  commands: Record<CheckKind, CommandEntry | null>;
  checks: Record<CheckKind, WorkspaceCheckConfig | null>;
  lines: Record<CheckKind, string>;
  options: Record<CheckKind, CheckOptions>;
};

export type RepoInfo = { commit: string; branch: string | null; dirty: boolean; changedFiles: number };

// workspace:check: validation plus a PATH lookup, nothing written.
export type WorkspaceCheck = {
  root: string | null;
  // The typed root when it was normalized to the repository top level.
  normalizedFrom: string | null;
  repo: RepoInfo | null;
  commands: Record<CheckKind, { configured: boolean; resolved: string | null }>;
};

export type WorkspaceInfo = { configured: false } | ({ configured: true; root: string } & RepoInfo);

// ========== preferences, environment, data ==========

export type Theme = 'system' | 'light' | 'dark';
export type AvatarColor = 'sunset' | 'ocean' | 'violet' | 'forest' | 'graphite';
export type PathSource = 'inherit' | 'login-shell';

// What preferences:set accepts.
export type PreferencesInput = {
  profile: { displayName: string; avatarColor: AvatarColor };
  appearance: { theme: Theme; vibrancy: boolean };
  environment: { pathSource: PathSource };
};

// Preferences as the renderer sees them, with derived display values.
export type Preferences = PreferencesInput & { profile: { initials: string } };

// `source` previews a choice before saving; `refresh` re-reads the login shell.
export type EnvironmentInfoOptions = { source?: PathSource; refresh?: boolean };

export type EnvironmentInfo = {
  requested: PathSource;
  // What was used: login-shell falls back to inherit on error.
  source: PathSource;
  error: ErrorInfo | null;
  shell: string | null;
  entries: string[];
  inheritedCount: number;
  platform: string;
  versions: { app: string | null; electron: string | null; node: string };
};

export type PackageSummary = { total: number; claimed: number; deviations: number };

export type DataInfo = { configDir: string; files: string[]; packages: PackageSummary };

// ========== requirements ==========

export type RequirementStatus = 'draft' | 'clarifying' | 'answering' | 'planning' | 'reviewing' | 'published' | 'failed';

// The agent step a run belongs to; also the step a failed requirement retries.
export type RequirementStep = 'clarifying' | 'planning';

// Which agent is working during a run.
export type RequirementPhase = 'architect' | 'product-lead';

export type RequirementInput = { title?: string; text: string };

// One answer per question, in order.
export type RequirementAnswers = string[];

export type RequirementQuestion = { text: string; answer: string };

export type PlanPackage = {
  title: string;
  description: string;
  module: string;
  tags: string[];
  priority: Priority;
  estimateHours: number;
  icon: string;
  steps: string[];
  fileScope: string[];
  acceptance: AcceptanceCriterion[];
};

export type RequirementPlan = { summary: string; packages: PlanPackage[] };

export type InterfaceModule = {
  path: string;
  purpose: string;
  members: { name: string; signature: string }[];
  dependsOn: string[];
  notes: string[];
};

export type InterfaceSummary = { modules: InterfaceModule[]; conventions: string[]; gaps: string[] };

// Architect's summary of the touched code, or why there isn't one.
export type RequirementInterfaces =
  | { summary: InterfaceSummary; text: string; read: { path: string; sha: string }[]; skipped: SkippedFile[]; error: null }
  | { summary: null; text: null; read: { path: string; sha: string }[]; skipped: SkippedFile[]; error: ErrorInfo | null };

export type Requirement = {
  id: string;
  status: RequirementStatus;
  title: string;
  text: string;
  summary: string | null;
  questions: RequirementQuestion[];
  plan: RequirementPlan | null;
  // Published task definitions.
  packages: TaskDefinition[];
  interfaces: RequirementInterfaces | null;
  phase: RequirementPhase | null;
  error: ErrorInfo | null;
  failedStep: RequirementStep | null;
  costUsd: number;
  createdAt: string;
  updatedAt: string;
};

// Whether the Claude Code CLI is on the command PATH.
export type AgentStatus = { available: boolean; command: string | null };

// ========== activity ==========

export type ActivityAgent = 'product-lead' | 'architect' | 'qa';

export type ActivityEvent =
  | { kind: 'package_transition'; packageId: string; title: string; transition: HumanTransition | AgentTransition; actor: 'human' | 'agent'; from: WorkPackageStatus; to: WorkPackageStatus }
  | { kind: 'requirement_created'; requirementId: string; title: string }
  | { kind: 'requirement_finished'; requirementId: string; title: string; step: RequirementStep; costUsd: number | null }
  | { kind: 'requirement_failed'; requirementId: string; title: string; step: RequirementStep; code: string }
  | { kind: 'requirement_published'; requirementId: string; title: string; packageCount: number };

export type ActivityRecord = ActivityEvent & { at: string };

export type QueueMetrics = { doneThisWeek: number; donePreviousWeek: number; averageHours: number | null; averageHoursPrevious: number | null };

// Which agents are busy right now; availability comes from AgentStatus.
export type TeamStatus = { available: boolean; busy: ActivityAgent[] };

export type ActivityOverview = { recent: ActivityRecord[]; metrics: QueueMetrics; team: TeamStatus; timeZone: string };

// Business days newest first; pass `nextBefore` back for the next page, null at the end.
export type ActivityPage = { days: { day: string; records: ActivityRecord[] }[]; nextBefore: string | null; timeZone: string; retentionDays: number };

// ========== engineering map ==========

export type MapSource = { requirementId: string; title: string; at: string };

// current: the file is unchanged since Architect read it; stale: it changed;
// removed: no longer tracked; unknown: no workspace or no recorded blob.
export type MapFreshness = 'current' | 'stale' | 'removed' | 'unknown';

export type MapModule = InterfaceModule & { source: MapSource; freshness: MapFreshness };

export type MapNote = { text: string; source: MapSource };

export type EngineeringMap = { modules: MapModule[]; conventions: MapNote[]; gaps: MapNote[]; files: string[]; truncated: boolean };

// ========== Environment Steward ==========

export type InstallMode = 'ci' | 'install' | 'skip';
export type ScriptKind = 'test' | 'lint' | 'build';
export type EnvBlocker = 'no_manifest' | 'invalid_manifest' | 'unsupported_manager' | 'node_missing' | 'npm_missing';

export type EnvManifest = {
  valid: boolean;
  name: string | null;
  scripts: Record<string, string>;
  engines: Record<string, string>;
  packageManager: string | null;
};

// env_setup.probe() facts, with workflow files reduced to their paths.
export type EnvFacts = {
  manifest: EnvManifest | null;
  lockfiles: string[];
  managers: string[];
  nodeModules: boolean;
  versionFiles: { path: string; content: string }[];
  workflows: string[];
  tools: { node: string | null; npm: string | null };
};

// Corrections TaskPilot made to the steward's plan.
export type EnvAdjustment =
  | { code: 'install_without_manifest' | 'ci_without_lockfile' }
  | { code: 'unknown_script'; kind: ScriptKind; script: string };

export type EnvPlan = {
  summary: string;
  install: InstallMode;
  installReason: string;
  scripts: Record<ScriptKind, string | null>;
  // Suggested fixes are shown, never run.
  issues: { text: string; fix: string }[];
  adjustments: EnvAdjustment[];
};

export type EnvStepResult = {
  line: string;
  ok: boolean;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  // Null for the install step.
  summary: RunSummary | null;
  output: string;
  at: string;
};

export type EnvStepId = 'install' | ScriptKind;

export type EnvStep = {
  id: EnvStepId;
  kind: EnvStepId;
  script: string | null;
  line: string;
  result: EnvStepResult | null;
};

export type EnvStatus = 'idle' | 'planning' | 'ready' | 'failed';

export type EnvState = {
  root: string | null;
  status: EnvStatus;
  // The plan was made for a different workspace root.
  stale: boolean;
  facts: EnvFacts | null;
  blockers: EnvBlocker[];
  plan: EnvPlan | null;
  error: IpcFailure | null;
  costUsd: number;
  allowScripts: boolean;
  // Id of the step running now.
  running: EnvStepId | null;
  steps: EnvStep[];
  // The workspace's current command line per kind ('' when not configured).
  configured: Record<CheckKind, string>;
};

// Re-planning after a failed step hands the steward that step's output.
export type EnvPlanOptions = { withFailure?: boolean };

// env:apply writes the scripts into workspace.json and returns the session.
export type EnvApplyResult = EnvState;
