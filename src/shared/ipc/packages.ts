// Work packages: their definition, execution state, QA review, Architect's ruling on a
// deviation and the practice reference and grade (tasks:*, package:*, review:*, deviation:*).

import type { CodingRun } from '../coding_types.ts';
import type { ErrorInfo } from './envelope.ts';
import type * as workspaceTypes from './workspace.ts';
import type { CourseRef, RubricItem } from '../course_pack.ts';
import type { HintUse } from '../hint_ladder.ts';

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

// A course lab: its id in taskpilot.toml's `labs`, its stage (1-based; each
// stage's public tests also run every earlier stage's) and its difficulty.
export type LabRef = { id: string; stage: number; difficulty: Difficulty };

// ========== practice ==========

// Coding Agent's reference solution for a practised package, generated in
// the background from the claimed commit and never applied. Its patch stays
// in the main process until it unlocks (ReferenceLock); revealedAt is when
// it was first read.
// A course lab's reference ships with the lab instead (source 'lab'): it is
// ready at the claim and no run is started. Absent source: a run.
export type ReferenceRun = {
  id: string;
  status: 'running' | 'ready' | 'failed' | 'cancelled';
  startedAt: string;
  finishedAt: string | null;
  error: ErrorInfo | null;
  files: { path: string; added: number; removed: number }[];
  costUsd: number | null;
  revealedAt: string | null;
  // Why it was open when first read; absent when unread, and on references
  // read before this was kept. hints_used means before the tests all passed.
  revealedWith?: 'tests_passed' | 'hints_used';
  source?: 'run' | 'lab';
};

// Whether a ready reference may be read. It opens once the package's tests
// all passed in a review (tests_passed) or the hint ladder was used up to L5
// (hints_used), and stays open once read (revealed).
export type ReferenceLock = { unlocked: boolean; reason: 'not_submitted' | 'tests_not_passed' | 'tests_passed' | 'hints_used' | 'revealed' };

// Tutor's marking of a practised submission against the reference, along
// the rubric of the course pack in use (for programming: thinking, writing,
// style). A category is a rubric item's id.
export type GradeCategory = string;
// repeated: one of the developer's notes already describes this mistake.
export type GradeComment = { category: GradeCategory; file: string | null; line: number | null; observation: string; betterWay: string; repeated: boolean };
// errorTags: the kinds of mistake Tutor named; absent on grades made before tags.
// levels: Tutor's level, 1 to 4, for each rubric item id; absent on grades made before scores.
export type GradeReport = { summary: string; strengths: string[]; comments: GradeComment[]; errorTags?: string[]; levels?: Record<string, number> };
// The two scores TaskPilot works out from a grade (../../main/grade_scores.ts),
// each 0–100, and what went into them, so every point can be shown.
// quality: tests and acceptance (of 40, by the share passed), QA's verdict
// (of 20) and the rubric levels (of 40). independence: 100 less what the
// developer used inside TaskPilot: hint levels (each level once), the
// reference read before the tests all passed, and how much of the
// submission matches code TaskPilot showed them.
export type GradeScores = {
  quality: number;
  independence: number;
  signals: {
    tests: { passed: number; total: number; points: number };
    qa: { passed: boolean; points: number };
    rubric: { points: number };
    hints: { level: number; deduction: number }[];
    reference: { beforePass: boolean; deduction: number };
    // ratio: the share of the submission's code matching what was shown, 0 to 1.
    similarity: { ratio: number; deduction: number };
  };
};
// After a grade made with the reference, Tutor picks up to three key
// differences from it and asks the developer why the reference does it that
// way; the developer explains each (or skips it), Tutor replies once, and
// the whole can be saved as one note. It counts towards neither score.
export type ExplanationItem = {
  // A rubric item id of the grade's pack.
  category: GradeCategory;
  file: string | null;
  // What the reference does differently, in plain words.
  difference: string;
  // Null when skipped, or not yet written.
  answer: string | null;
  // Tutor's one reply; null before it, and for a skipped item.
  feedback: { correct: boolean; missed: string | null } | null;
};
// picking: Tutor is choosing the differences; answering: waiting for the
// developer; reviewing: Tutor is replying; failed keeps the items, so a
// failed reply can be asked again with the same answers.
export type GradeExplanation = {
  status: 'picking' | 'answering' | 'reviewing' | 'done' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  error: ErrorInfo | null;
  items: ExplanationItem[];
  // At least one item was explained and Tutor replied.
  completed: boolean;
  // The note it was saved as; null before.
  noteId: string | null;
  costUsd: number;
};
// The course pack a grade was made with, and its rubric as it was then.
export type GradeCourse = Pick<CourseRef, 'id' | 'version' | 'contentHash'> & { rubric: RubricItem[] };
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
  // [人工决策-2026-10-26 15:38:21] 判卷时快照课程包和 rubric；旧记录没有这个字段，显示时按内置 programming 包处理，不改写旧文件。
  course?: GradeCourse;
  // [人工决策-2026-10-27 00:36:21] 判卷分开打质量分和独立完成度；判卷后让学生解释和参考实现的差异。旧记录没有这两个字段，显示时不报错。
  scores?: GradeScores;
  explanation?: GradeExplanation;
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
  // The course pack it was planned with; absent on older packages (programming).
  course?: CourseRef;
  // Concept ids of the course pack the package practises.
  concepts?: string[];
  // Set on a course lab; absent on project packages.
  lab?: LabRef;
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
  // The hint ladder levels opened in this claim and the snippets copied (../hint_ladder.ts).
  hints: HintUse[];
  snippetCopies: number;
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
  // Null unless the reference is ready.
  referenceLock: ReferenceLock | null;
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
