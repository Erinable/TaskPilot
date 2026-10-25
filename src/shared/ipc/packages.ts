// Work packages: their definition, execution state, QA review, Architect's ruling on a
// deviation and the practice reference and grade (tasks:*, package:*, review:*, deviation:*).

import type { CodingRun } from '../coding_types.ts';
import type { ErrorInfo } from './envelope.ts';
import type * as workspaceTypes from './workspace.ts';

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
// repeated: one of the developer's notes already describes this mistake.
export type GradeComment = { category: GradeCategory; file: string | null; line: number | null; observation: string; betterWay: string; repeated: boolean };
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
  acceptance: workspaceTypes.AcceptanceCriterion[];
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
export type RevisionDefinition = { steps: string[]; fileScope: string[]; acceptance: workspaceTypes.AcceptanceCriterion[] };

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

export type ReviewCheck = workspaceTypes.Evidence & { run: workspaceTypes.CompactRun | null };

type ReviewTiming = { startedAt: string; finishedAt: string | null };

export type Review =
  | (ReviewTiming & { status: 'running'; error: null })
  // The running entry plus why it could not finish.
  | (ReviewTiming & { status: 'failed'; error: ErrorInfo })
  | (ReviewTiming & {
      status: 'passed' | 'rejected';
      error: null;
      reasons: ReviewReason[];
      attention: workspaceTypes.AttentionItem[];
      checks: ReviewCheck[];
      // The unit-test run, as the execution page shows it.
      verification: workspaceTypes.CompactRun | null;
      acceptance: workspaceTypes.CriterionEvidence[];
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
  baselineChecks: workspaceTypes.BaselineChecks | null;
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
  baselineChecks: workspaceTypes.BaselineChecks | null;
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
  baselineChecks: workspaceTypes.BaselineChecks | null;
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
