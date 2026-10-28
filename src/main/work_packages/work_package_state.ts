import * as status from './work_package_status.ts';
import type { TransitionName, WorkPackageStatus } from './work_package_status.ts';
import type { TaskDefinition, TaskRevisionDefinition } from './tasks.ts';
import type { AttentionItem, BaselineCheck, CriterionResult, EvidenceItem } from '../checking/evidence.ts';
import type { StepId as CheckKind } from '../../shared/check_steps.ts';
import type { CodingRun } from '../../shared/coding_types.ts';
import type { ErrorCode } from '../../shared/error_codes.ts';
import type { HintUse } from '../../shared/hint_ladder.ts';
import type { ExecutionMode, ReferenceRun, Grade } from '../../shared/ipc/packages.ts';

// Why an agent run failed.
export interface AgentError {
  code: ErrorCode;
  message: string;
}

export type ReviewStatus = 'running' | 'passed' | 'rejected' | 'failed';

// QA's latest review of a package. The result fields are present once it finished.
export interface Review {
  status: ReviewStatus;
  startedAt: string;
  finishedAt: string | null;
  error: AgentError | null;
  reasons?: string[];
  attention?: AttentionItem[];
  checks?: EvidenceItem[];
  verification?: unknown;
  acceptance?: CriterionResult[];
  report?: unknown;
  diff?: unknown;
  costUsd?: number;
  // The human's call on QA's pass.
  humanVerdict?: 'accepted' | 'acceptance_rejected';
  humanAt?: string;
}

// pipeline.reviewWorkPackage() result, as completeReview() reads it.
export interface ReviewResult {
  passed: boolean;
  reasons: string[];
  attention?: AttentionItem[];
  checks?: EvidenceItem[];
  verification?: unknown;
  acceptance?: CriterionResult[];
  report?: unknown;
  diff?: unknown;
  costUsd?: number;
}

export type BaselineChecksStatus = 'measuring' | 'measured' | 'unavailable' | 'contaminated';

// Submit-stage checks run on the claimed commit.
export interface BaselineChecks {
  status: BaselineChecksStatus;
  reason: string | null;
  commit: string;
  checks: Partial<Record<CheckKind, BaselineCheck>>;
  startedAt: string;
  finishedAt: string | null;
}

export type AdjudicationDecision = 'dismiss' | 'replan';

// Architect's ruling on a deviation.
export interface DeviationResolution {
  decision: AdjudicationDecision;
  reason: string;
  changes: string[];
  decidedAt: string;
  afterContest: boolean;
  contested: boolean;
  reverted: boolean;
}

// A deviation the developer reported.
export interface Deviation {
  note: string;
  stepIndex: number | null;
  filePath: string | null;
  reportedAt: string;
  resolution: DeviationResolution | null;
}

// What the developer sends when reporting a deviation (untrusted).
export interface DeviationInput {
  note?: string;
  stepIndex?: unknown;
  filePath?: unknown;
}

// Architect's replan of a definition, overlaid by effective().
export interface PlanRevision {
  version: number;
  definition: TaskRevisionDefinition;
  reason: string;
  changes: string[];
  revisedAt: string;
}

export type AdjudicationStatus = 'running' | 'done' | 'failed';

// Architect's latest run on a deviation.
export interface Adjudication {
  status: AdjudicationStatus;
  mustReplan: boolean;
  startedAt: string;
  finishedAt: string | null;
  error: AgentError | null;
  read?: string[];
  skipped?: unknown[];
  costUsd?: number;
}

// pipeline.adjudicateDeviation() result, as completeAdjudication() reads it.
export interface AdjudicationOutcome {
  decision: AdjudicationDecision;
  reason: string;
  changes: string[];
  revision: TaskRevisionDefinition | null;
  read?: string[];
  skipped?: unknown[];
  costUsd?: number;
}

// Execution state kept from before a replan so the human can revert it.
export interface ReplanUndo {
  revision: PlanRevision | null;
  baseline: string | null;
  claimedAt: string | null;
  completedSteps: number[];
  baselineChecks: BaselineChecks | null;
  review: Review | null;
  // Absent on undo records saved before modes existed.
  mode?: ExecutionMode | null;
  // Absent on undo records saved before the hint ladder.
  hints?: HintUse[];
  snippetCopies?: number;
}

// Runtime state of one work package.
export interface WorkPackageState {
  status: WorkPackageStatus;
  baseline: string | null;
  claimedAt: string | null;
  completedSteps: number[];
  deviations: Deviation[];
  review: Review | null;
  baselineChecks: BaselineChecks | null;
  revision: PlanRevision | null;
  adjudication: Adjudication | null;
  replanUndo: ReplanUndo | null;
  codingRun: CodingRun | null;
  // Who writes the code, chosen at claim. Null before a claim, after a
  // release or replan, and on packages claimed before modes existed.
  mode: ExecutionMode | null;
  // Practice only: Coding Agent's reference solution and Tutor's grading.
  // Both belong to one claim of one plan, so release and replan clear them.
  referenceRun: ReferenceRun | null;
  grade: Grade | null;
  // When the package reached done, for estimate-vs-actual; null before.
  completedAt: string | null;
  // Dependencies the developer chose to skip; they no longer block claiming.
  waivedDependencies: string[];
  // The hint ladder levels opened in this claim, each level of a step once,
  // and how often a Tutor snippet was copied. Release and replan clear them,
  // like the practice records; saved before the ladder, they load empty.
  hints: HintUse[];
  snippetCopies: number;
}

export interface StoreSummary {
  total: number;
  claimed: number;
  deviations: number;
}

export type StoreErrorCode =
  | 'unknown_package'
  | 'invalid_state'
  | 'baseline_required'
  | 'deviation_note_required'
  | 'invalid_argument'
  | 'review_running'
  | 'review_not_running'
  | 'adjudication_running'
  | 'adjudication_not_running'
  | 'invalid_step';

export class StoreError extends Error {
  code: StoreErrorCode;

  constructor(message: string, code: StoreErrorCode) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

export const initialState = (task: Pick<TaskDefinition, 'status'>): WorkPackageState => ({
  status: task.status,
  baseline: null, // git commit recorded when the human claims the package
  claimedAt: null,
  completedSteps: [], // indices into task.steps
  deviations: [],
  review: null, // QA's latest review; see beginReview()
  baselineChecks: null,
  revision: null,
  adjudication: null, // Architect's latest run on a deviation
  replanUndo: null,
  codingRun: null,
  mode: null,
  referenceRun: null,
  grade: null,
  completedAt: null,
  waivedDependencies: [],
  hints: [],
  snippetCopies: 0,
});

export const BASELINE_STATUSES: string[] = ['measuring', 'measured', 'unavailable', 'contaminated'];

// The transition Architect's ruling applies.
export const ADJUDICATION_TRANSITIONS: Record<AdjudicationDecision, TransitionName> = { dismiss: 'deviation_dismissed', replan: 'replanned' };

export const lastDeviation = (entry: WorkPackageState): Deviation | null => entry.deviations[entry.deviations.length - 1] ?? null;

// Human transitions that also depend on state beyond the status.
export const GUARDS: Partial<Record<string, (entry: WorkPackageState) => boolean>> = {
  // Only an uncontested dismissal can be contested.
  override_dismissal: (entry) => {
    const resolution = lastDeviation(entry)?.resolution;
    return resolution?.decision === 'dismiss' && !resolution.contested;
  },
  revert_replan: (entry) => entry.replanUndo !== null,
};
export const allowed = (entry: WorkPackageState, name: string) => GUARDS[name]?.(entry) ?? true;

// Human transitions available for an entry, after the state guards.
export const humanTransitions = (entry: WorkPackageState): TransitionName[] =>
  status
    .available(entry.status, 'human')
    .map((t) => t.name)
    .filter((name) => allowed(entry, name));

// The task fields the store needs: its id and seed status.
export type StoreTask = Pick<TaskDefinition, 'id' | 'status'>;

// Puts back the plan and the claim a replan replaced.
export const revertReplan = (entry: WorkPackageState) => {
  // The guard checked there is something to revert.
  const undo = entry.replanUndo as ReplanUndo;
  (lastDeviation(entry) as Deviation & { resolution: DeviationResolution }).resolution.reverted = true;
  entry.revision = undo.revision;
  entry.baseline = undo.baseline;
  entry.claimedAt = undo.claimedAt;
  entry.completedSteps = undo.completedSteps;
  entry.baselineChecks = undo.baselineChecks;
  entry.review = undo.review;
  entry.mode = undo.mode ?? null;
  entry.hints = undo.hints ?? [];
  entry.snippetCopies = undo.snippetCopies ?? 0;
  entry.replanUndo = null;
};

export const recoverCodingRun = (state: WorkPackageState) => {
  if (state.codingRun && !state.codingRun.cli) state.codingRun = { ...state.codingRun, cli: 'codex', model: '', thinking: 'default' };
  if (state.codingRun && state.codingRun.attempt === undefined)
    state.codingRun = { ...state.codingRun, attempt: 1, trigger: 'human', feedback: null, halt: null, rounds: [] };
  if (state.codingRun?.status === 'verifying') {
    state.codingRun = {
      ...state.codingRun,
      status: 'applied',
      halt: 'stopped',
      error: { code: 'coding_interrupted', message: 'Checks were interrupted when the app closed' },
    };
  }
  if (state.codingRun && ['preparing', 'running', 'checking', 'applying'].includes(state.codingRun.status)) {
    state.codingRun = {
      ...state.codingRun,
      status: 'failed',
      finishedAt: null,
      error: { code: 'coding_interrupted', message: 'Coding Agent was interrupted when the app closed' },
    };
  }
};

export const recoverInterruptedAgents = (state: WorkPackageState) => {
  if (state.review?.status === 'running') {
    state.review = {
      ...state.review,
      status: 'failed',
      finishedAt: null,
      error: { code: 'agent_interrupted', message: 'The review was interrupted when the app closed' },
    };
  }
  if (state.baselineChecks?.status === 'measuring')
    state.baselineChecks = { ...state.baselineChecks, status: 'unavailable', reason: 'interrupted', finishedAt: null };
  if (state.adjudication?.status === 'running') {
    state.adjudication = {
      ...state.adjudication,
      status: 'failed',
      finishedAt: null,
      error: { code: 'agent_interrupted', message: 'The adjudication was interrupted when the app closed' },
    };
  }
  if (state.referenceRun?.status === 'running') {
    state.referenceRun = {
      ...state.referenceRun,
      status: 'failed',
      error: { code: 'coding_interrupted', message: 'The reference run was interrupted when the app closed' },
    };
  }
  if (state.grade && ['waiting', 'running'].includes(state.grade.status)) {
    state.grade = { ...state.grade, status: 'failed', error: { code: 'agent_interrupted', message: 'Grading was interrupted when the app closed' } };
  }
  const explanation = state.grade?.explanation;
  if (state.grade && explanation && ['picking', 'reviewing'].includes(explanation.status)) {
    state.grade = {
      ...state.grade,
      explanation: { ...explanation, status: 'failed', error: { code: 'agent_interrupted', message: 'Tutor was interrupted when the app closed' } },
    };
  }
};
