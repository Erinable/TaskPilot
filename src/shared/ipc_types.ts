// The wire contract between the main process and the renderer: every shape
// that crosses IPC, as plain structural types. Nothing here imports from
// src/main, because the renderer typechecks without it; src/main/ipc.ts
// annotates its handlers with these types so drift fails tsc.

import type { CodingRun } from './coding_types.ts';
import type { AgentId, AgentSettings, CliId } from './agent_runtime.ts';
export type { AgentId, AgentRuntimeConfig, AgentRuntimeStatus, AgentSettings, CliId, ThinkingLevel } from './agent_runtime.ts';
export type { CliModelCatalog, CliModelOption, CliModelScope, CliModelsRequest } from './agent_runtime.ts';
export type {
  CodingApply,
  CodingApplyResult,
  CodingEvent,
  CodingEventPage,
  CodingPatchFile,
  CodingPatchPreview,
  CodingRun,
  CodingRuntimeStatus,
  CodingActiveRun,
  CodingHalt,
  CodingMergeFile,
  CodingResolution,
  CodingRound,
  CodingRunStatus,
  CodingStart,
  CodingTrigger,
  CodingUsage,
} from './coding_types.ts';
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
  | 'claim'
  | 'revert_replan'
  | 'release'
  | 'submit_for_review'
  | 'report_deviation'
  | 'override_dismissal'
  | 'block'
  | 'accepted'
  | 'acceptance_rejected'
  | 'unblock';

export type AgentTransition = 'breakdown_done' | 'review_accepted' | 'review_passed' | 'review_rejected' | 'replanned' | 'deviation_dismissed';

// The one transition Coding Agent triggers: its applied patch passed the submit checks.
export type CodingTransition = 'coding_submitted';

export type Priority = 'high' | 'medium' | 'low';

// How hard a package is for someone new to programming, and why, in plain
// words. Product Lead sets it; packages planned before it existed have none.
export type Difficulty = 'easy' | 'medium' | 'hard';
export type PackageDifficulty = { level: Difficulty; reason: string };

// Who writes a package's code, chosen when it is claimed:
//   practice  the developer, as an exercise (Coding Agent stays out)
//   ai        Coding Agent
//   self      the developer, with Coding Agent available
export type ExecutionMode = 'practice' | 'ai' | 'self';
// Product Lead recommends one of the first two, with a plain reason;
// packages planned before it existed have none.
export type PlannedMode = Exclude<ExecutionMode, 'self'>;
export type ModeRecommendation = { mode: PlannedMode; reason: string };

// ========== practice ==========

// Coding Agent's reference solution for a practised package, generated in
// the background from the claimed commit and never applied. Its patch stays
// in the main process until the developer first submits (revealedAt).
export type ReferenceRun = {
  id: string;
  status: 'running' | 'ready' | 'failed' | 'cancelled';
  startedAt: string;
  finishedAt: string | null;
  error: ErrorInfo | null;
  files: { path: string; added: number; removed: number }[];
  costUsd: number | null;
  revealedAt: string | null;
};

// Tutor's marking of a practised submission against the reference.
//   thinking  how the problem was approached
//   writing   how the code does it (constructs, APIs, error handling)
//   style     naming, layout and the repository's conventions
export type GradeCategory = 'thinking' | 'writing' | 'style';
export type GradeComment = { category: GradeCategory; file: string | null; line: number | null; observation: string; betterWay: string };
export type GradeReport = { summary: string; strengths: string[]; comments: GradeComment[] };
// waiting: QA has finished but the reference is still being written.
export type Grade = {
  id: string;
  status: 'waiting' | 'running' | 'done' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  error: ErrorInfo | null;
  // The submission graded; the same diff is not graded twice.
  diffDigest: string;
  withReference: boolean;
  report: GradeReport | null;
  costUsd: number;
};

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
  difficulty?: PackageDifficulty;
  recommendedMode?: ModeRecommendation;
  // Ids of packages from the same requirement that must be done first.
  // Absent on packages planned before dependencies existed.
  dependsOn?: string[];
  // The plan's estimate as a number; older packages only have `estimate`.
  estimateHours?: number;
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

// `mode` goes with claim; a claim without one leaves the mode unknown.
export type TransitionOptions = { deviation?: DeviationInput; mode?: ExecutionMode };

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
  // Absent on undo records saved before modes existed.
  mode?: ExecutionMode | null;
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
  codingRun: CodingRun | null;
  // Chosen at claim; null before, after a release or replan, and on
  // packages claimed before modes existed.
  mode: ExecutionMode | null;
  // Practice only; cleared on release and replan.
  referenceRun: ReferenceRun | null;
  grade: Grade | null;
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
  codingRun: CodingRun | null;
  mode: ExecutionMode | null;
  referenceRun: ReferenceRun | null;
  grade: Grade | null;
  // Null when never replanned; the definition itself is already applied.
  revision: Omit<Revision, 'definition'> | null;
  // Human transitions available now, after the state guards.
  humanTransitions: HumanTransition[];
  // Every declared dependency with where it stands. `blocking` ones keep a
  // pending package from being claimed.
  dependencies: PackageDependency[];
  // When the package reached done; null before.
  completedAt: string | null;
};

// One dependency of a package, as the queue shows it.
export type PackageDependency = {
  id: string;
  // Null when the package no longer exists (its requirement was removed).
  title: string | null;
  status: WorkPackageStatus | null;
  waived: boolean;
  blocking: boolean;
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
  repo: RepoInfo | null;
  commands: Record<CheckKind, { configured: boolean; resolved: string | null }>;
};

export type WorkspaceInfo = { configured: false } | ({ configured: true; root: string } & RepoInfo);

// workspace:open-file: where the file ended up. 'folder' means no editor was
// found and the file was shown in the file manager instead.
export type OpenedWith = 'vscode' | 'text_editor' | 'folder';

// ========== preferences, environment, data ==========

export type Theme = 'system' | 'light' | 'dark';
export type AvatarColor = 'sunset' | 'ocean' | 'violet' | 'forest' | 'graphite';
export type PathSource = 'inherit' | 'login-shell';

// What preferences:set accepts.
export type PreferencesInput = {
  profile: { displayName: string; avatarColor: AvatarColor };
  appearance: { theme: Theme; vibrancy: boolean };
  environment: { pathSource: PathSource };
  agents: AgentSettings;
  // How the Coding Agent is isolated (the folders only apply to sandbox mode),
  // and how long one coding round may run.
  coding: { isolation: 'sandbox' | 'separate-user'; extraRead: string[]; extraWrite: string[]; timeoutMinutes: 15 | 30 | 60 | 120 };
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
  difficulty?: PackageDifficulty;
  recommendedMode?: ModeRecommendation;
  // 1-based numbers of earlier packages; absent on plans saved before it existed.
  dependsOn?: number[];
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

// Whether a CLI has credentials, checked offline. `unknown`: the CLI has no
// offline check and no credential file was found; it may still work.
export type CliSignIn = { state: 'signed_in' | 'signed_out' | 'unknown'; source: string | null };

// The analysis CLI (Product Lead and Architect) and the coding CLI: installed
// and usable, and signed in. Sign-in is null when the CLI is not installed.
export type AgentStatus = {
  available: boolean;
  command: string | null;
  signIn: CliSignIn | null;
  coding: { cli: CliId; installed: boolean; signIn: CliSignIn | null };
};

// ========== activity ==========

export type ActivityAgent = 'product-lead' | 'architect' | 'qa' | 'release-manager' | 'coding-agent';

export type ActivityEvent =
  | {
      kind: 'package_transition';
      packageId: string;
      title: string;
      transition: HumanTransition | AgentTransition | CodingTransition;
      actor: 'human' | 'agent' | 'coding-agent';
      from: WorkPackageStatus;
      to: WorkPackageStatus;
    }
  | { kind: 'coding_run'; packageId: string; title: string; status: 'started' | 'finished' | 'failed' | 'cancelled'; costUsd: number | null }
  | { kind: 'requirement_created'; requirementId: string; title: string }
  | { kind: 'requirement_finished'; requirementId: string; title: string; step: RequirementStep; costUsd: number | null }
  | { kind: 'requirement_failed'; requirementId: string; title: string; step: RequirementStep; code: string }
  | { kind: 'requirement_published'; requirementId: string; title: string; packageCount: number }
  | { kind: 'release_finished'; version: string; packageCount: number };

export type ActivityRecord = ActivityEvent & { at: string };

export type QueueMetrics = { doneThisWeek: number; donePreviousWeek: number; averageHours: number | null; averageHoursPrevious: number | null };

// What an agent is running right now. `label` is the requirement or package title.
export type AgentWork = { agent: ActivityAgent; kind: 'requirement' | 'review' | 'adjudication' | 'release' | 'coding'; label: string };

// Which agents are busy right now; availability is tracked per runtime.
export type TeamStatus = { available: boolean; availableByAgent: Record<ActivityAgent, boolean>; busy: ActivityAgent[]; work: AgentWork[] };

// Model spend per agent over the metrics week. Spend is recorded from
// 2026-10-07; `since` is the earliest recorded run in the retention window
// (null if none), so a week that starts before it is only partly counted.
export type AgentCosts = { byAgent: Record<ActivityAgent, number>; since: string | null; partial: boolean };

// ========== model usage ==========

// Token counts one model call reported, normalized across CLIs. `input`
// excludes cache reads and writes; reasoning is already inside `output`.
export type TokenUsage = { input: number; output: number; cacheRead: number; cacheWrite: number };
// What one call ran on, as far as the CLI said. Unknown parts are null.
export type ModelCall = { cli: CliId; provider: string | null; model: string | null; costUsd: number | null; tokens: TokenUsage | null };
// The work a call was for.
export type CostSubject = { kind: 'package' | 'requirement'; id: string } | null;

// Spend of a group of calls. `actualUsd` the CLIs reported; `estimatedUsd`
// is tokens × models.dev price; `unknownCalls` have neither. Of those,
// `unpricedCalls` have tokens, so a price sync may estimate them.
export type CostBucket = {
  calls: number;
  actualUsd: number;
  estimatedUsd: number;
  unknownCalls: number;
  unpricedCalls: number;
  tokens: TokenUsage;
};
export type CostRange = 7 | 30 | 90;
// Subjects exist only for days still within the 30-day raw window.
export type CostReport = {
  days: CostRange;
  timeZone: string;
  total: CostBucket;
  byAgent: (CostBucket & { agent: AgentId })[];
  byDay: (CostBucket & { day: string })[];
  byModel: (CostBucket & { cli: CliId | null; provider: string | null; model: string | null })[];
  bySubject: (CostBucket & { kind: 'package' | 'requirement'; id: string; title: string })[];
  // Days before this come from the yearly rollup (no subjects); null if none.
  rollupBefore: string | null;
  prices: { syncedAt: string } | null;
};

// `teamRecent`: each agent's newest few events over the retention window, newest first.
export type ActivityOverview = {
  recent: ActivityRecord[];
  metrics: QueueMetrics;
  team: TeamStatus;
  costs: AgentCosts;
  teamRecent: Record<ActivityAgent, ActivityRecord[]>;
  timeZone: string;
};

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
  // Dependencies that only work after their install scripts run.
  installScripts: string[];
};

// Corrections TaskPilot made to the steward's plan.
export type EnvAdjustment = { code: 'install_without_manifest' | 'ci_without_lockfile' } | { code: 'unknown_script'; kind: ScriptKind; script: string };

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

export type EnvStepId = 'install' | 'rebuild' | ScriptKind;

export type EnvStep = {
  id: EnvStepId;
  kind: EnvStepId;
  script: string | null;
  // For the rebuild step: the packages whose install scripts it runs.
  packages: string[];
  // The step deletes node_modules before installing (npm ci over an
  // existing install), so it asks before running.
  replacesInstall: boolean;
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
  // The running step's latest output and its start time; null when idle.
  live: { output: string; startedAt: string } | null;
  steps: EnvStep[];
  // The workspace's current command line per kind ('' when not configured).
  configured: Record<CheckKind, string>;
};

// Re-planning after a failed step hands the steward that step's output.
export type EnvPlanOptions = { withFailure?: boolean };

// env:apply writes the scripts into workspace.json and returns the session.
export type EnvApplyResult = EnvState;

// ========== Release Manager ==========

export type ReleaseBump = 'major' | 'minor' | 'patch';

// Each group is a short list of lines in Simplified Chinese.
export type ReleaseNotes = { added: string[]; fixed: string[]; changed: string[]; notes: string[] };

// evidence: paths or short shas that appeared in the input.
export type ReleaseChecklistItem = { text: string; evidence: string[] };

export type ReleasePlan = {
  bump: ReleaseBump;
  reason: string;
  // package.json version at HEAD; null when absent or not semver.
  currentVersion: string | null;
  // Computed by TaskPilot from currentVersion and bump.
  nextVersion: string;
  notes: ReleaseNotes;
  checklist: ReleaseChecklistItem[];
};

// Where the next release starts: the last finished release, the newest tag
// reachable from HEAD, or nothing (the user picks a recent commit).
// commitCount/packageCount preview what a run would include: commits in
// start..HEAD (capped at 200, commitsTruncated past that) and done packages
// no earlier release included. Zero for 'none'. Optional so the change is
// additive; release:get always sets them.
type ReleasePreview = { commitCount?: number; commitsTruncated?: boolean; packageCount?: number };

export type ReleaseStartPoint =
  ({ kind: 'release' | 'tag'; commit: string; label: string } & ReleasePreview) | ({ kind: 'none'; commit: null; label: null } & ReleasePreview);

// What TaskPilot collected for the run, as counts for the page.
export type ReleaseInputSummary = {
  commitCount: number;
  commitsTruncated: boolean;
  fileCount: number;
  filesTruncated: boolean;
  packageIds: string[];
};

export type ReleaseDraftStatus = 'generating' | 'ready' | 'failed';

export type ReleaseDraft = {
  status: ReleaseDraftStatus;
  error: ErrorInfo | null;
  startCommit: string;
  // HEAD the draft was generated for.
  endCommit: string;
  input: ReleaseInputSummary | null;
  plan: ReleasePlan | null;
  // Editable Markdown body, generated from plan.notes.
  notesText: string;
  // Indices into plan.checklist the user has ticked.
  checked: number[];
  costUsd: number;
  startedAt: string;
  updatedAt: string;
};

export type Release = {
  id: string;
  version: string;
  startCommit: string;
  endCommit: string;
  notesText: string;
  checklist: (ReleaseChecklistItem & { checked: boolean })[];
  packageIds: string[];
  finishedAt: string;
};

// A version plan: the requirements a version is meant to ship.
export type Milestone = {
  id: string;
  version: string;
  // YYYY-MM-DD, optional.
  targetDate: string | null;
  requirementIds: string[];
  createdAt: string;
  // Set when a release of this version is finished.
  releasedAt: string | null;
};

// What the release page sends to create or edit a milestone.
export type MilestoneInput = { version: string; targetDate: string | null; requirementIds: string[] };

// A milestone with its requirements' progress, for the release page.
export type MilestoneView = Milestone & {
  requirements: { id: string; title: string; done: number; total: number }[];
  done: number;
  total: number;
  // Every package of every requirement is done.
  complete: boolean;
};

export type ReleaseState = {
  configured: boolean;
  draft: ReleaseDraft | null;
  // Open milestones first (by target date), then released ones.
  milestones: MilestoneView[];
  // Newest first, at most 50.
  history: Release[];
  // Null without a workspace.
  startPoint: ReleaseStartPoint | null;
  // A generation is running and can be cancelled.
  running: boolean;
};

export type ReleaseCommit = { sha: string; subject: string; date: string };

export type ReleaseDraftInput = { notes?: string; checked?: number[] };

// Relative to the workspace root, ending in .md.
export type ReleaseWriteInput = { path: string };

export type ReleaseWriteResult = { path: string };

// ========== repositories ==========

export type Repository = {
  id: string;
  root: string;
  // Directory name, for display.
  name: string;
  lastOpenedAt: string;
  current: boolean;
  // The root no longer holds a git repository (moved, renamed or deleted).
  missing: boolean;
  // Work waiting in it; null when its saved data could not be read.
  counts: RepositoryCounts | null;
};

// active: in progress, in review, in deviation or blocked.
export type RepositoryCounts = { pending: number; active: number; accepting: number };

export type RepositoryList = { repositories: Repository[]; current: string | null };

// Background work a switch would cancel.
export type BusyKind = 'requirement' | 'review' | 'adjudication' | 'baseline' | 'release' | 'environment' | 'tutor' | 'coding' | 'reference' | 'grade';
export type BusyRun = { kind: BusyKind; label: string };

// ========== commit ==========

export type CommitSkipReason = 'out_of_scope' | 'secret' | 'rename';

// What committing a finished package would include, from git status.
export type CommitPreview = {
  // Inside the package's file scope; committed as listed.
  files: string[];
  // Held back; the developer commits these by hand if they mean to.
  skipped: { path: string; reason: CommitSkipReason }[];
  // Suggested message; the developer may edit it.
  message: string;
};

export type CommitResult = { commit: string; files: string[] };

// ========== tutor ==========

export type TutorAnswer = {
  explanation: string;
  hints: string[];
  snippet: { language: string; code: string } | null;
  terms: { term: string; meaning: string }[];
};

// One step's help: idle (never asked, or asked for an older wording),
// running, done or failed.
export type TutorState = {
  status: 'idle' | 'running' | 'done' | 'failed';
  answer: TutorAnswer | null;
  error: ErrorInfo | null;
  costUsd: number;
};
