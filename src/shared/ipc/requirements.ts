// Requirements and their plans (requirements:*).

import type { ErrorInfo } from './envelope.ts';
import type * as packageTypes from './packages.ts';
import type { AcceptanceCriterion } from './workspace.ts';
import type { Concept, CoursePack, CourseRef } from '../course_pack.ts';
import type { CoursePlan, GoalForm } from '../course_plan.ts';
import type { LabToolchainId } from '../lab_toolchains.ts';
import { invoke } from './contract.ts';
import type { Contract } from './contract.ts';
import type { PathEntry } from '../course_plan.ts';

export type RequirementStatus = 'draft' | 'clarifying' | 'answering' | 'planning' | 'reviewing' | 'published' | 'failed';

// The agent step a run belongs to; also the step a failed requirement retries.
export type RequirementStep = 'clarifying' | 'planning';

// Which agent is working during a run.
export type RequirementPhase = 'architect' | 'product-lead' | 'tutor';

// A project asks for work on the repository; a course for a learning path.
export type RequirementKind = 'project' | 'course';

// `course` makes a course requirement: `text` is what the learner wants to learn.
export type RequirementInput = { title?: string; text: string; course?: GoalForm };

// The pack a course path is planned from: one offered, or a new draft.
export type CourseChoice = { course: string } | { draft: true };

export type CourseInterview = {
  form: GoalForm;
  // The packs offered and Tutor's pick (null when none fits).
  pick: { course: string | null; reason: string; options: { id: string; title: string }[] } | null;
  choice: CourseChoice | null;
  plan: CoursePlan | null;
  // The skeleton's concepts on the path, for their labels and prerequisites.
  pathConcepts: Concept[];
  // A drafted pack, validated, until the learner saves and confirms it.
  draft: { pack: CoursePack; contentHash: string } | null;
  // The latest lab's generation, once the path is confirmed; absent before.
  lab?: LabGeneration | null;
  // The lab repository the labs are written into, once created.
  repositoryId?: string | null;
};

// What the learner sees of a lab being generated: never its code, solution,
// tests or hints, only their counts. `phase` is the call running: the
// statement and tests (spec), then the code, then the self-check (verify)
// and its repairs. `ready` means the self-check passed; `needs_review` that
// it still failed after two repairs.
export type LabGeneration = {
  status: 'running' | 'ready' | 'needs_review' | 'failed';
  phase: 'spec' | 'code' | 'verify' | 'repair' | null;
  concepts: string[];
  difficulty: packageTypes.Difficulty;
  startedAt: string;
  finishedAt: string | null;
  costUsd: number;
  lab: { id: string; title: string; summary: string; estimateHours: number; starterFiles: number; publicTests: number; hiddenTests: number } | null;
  // The self-check so far; absent on labs generated before it existed.
  verify?: LabVerify | null;
  error: ErrorInfo | null;
  // The lab repository stage it was generated for, and whether it has been
  // written there; absent on labs from before lab repositories (stage 1).
  stage?: number;
  placed?: boolean;
};

export type LabVerifyCheck = 'reference' | 'starter' | 'mutants' | 'consistency';

// One self-check round: each check's verdict (mutants is null when skipped
// because the solution failed), the mutant counts and the number of review
// issues. Test names, mutants and issues themselves stay private.
export type LabVerifyRound = {
  round: number;
  checks: Record<LabVerifyCheck, boolean | null>;
  mutants: { killed: number; publicKilled: number; total: number } | null;
  issues: number;
  repaired: boolean;
};

// `round` is the round running or the last one; `maxRounds` counts the first and the retries.
export type LabVerify = { round: number; maxRounds: number; rounds: LabVerifyRound[]; costUsd: number };

// requirements:lab-estimate: what generating the first lab and checking it
// would cover and roughly cost, shown before the learner confirms. `usd` is
// null when no price is known for the model (sync prices on the cost page).
// `calls` is a run whose first self-check passes; `maxCalls` one that
// repairs twice.
// `change` says how the difficulty moved from the concept's last lab (or
// the lab just done); `stuck` lists the concept's notes when its labs kept
// failing at easy, so the learner reviews them or marks the concept skipped
// (requirements:course-skip) instead of generating it again.
// `toolchain` is the course's toolchain checked under the self-check's
// sandbox: each tool's version (null when missing) and how to install it;
// generating is refused until it is ready.
export type LabEstimate = {
  concepts: { id: string; label: string }[];
  difficulty: packageTypes.Difficulty;
  change: 'lowered' | 'raised' | 'kept';
  stuck: { notes: { id: string; title: string }[] } | null;
  calls: number;
  maxCalls: number;
  tokens: { input: number; output: number };
  model: string | null;
  usd: { low: number; high: number } | null;
  toolchain: LabToolchainCheck;
};

// `problem` is sandbox_unavailable when there is no sandbox to check under
// (the self-check refuses to run without one); `ready` when every tool ran.
export type LabToolchainCheck = {
  id: LabToolchainId;
  tools: { command: string; version: string | null; install: string }[];
  ready: boolean;
  problem: 'sandbox_unavailable' | null;
};

// requirements:course-save-draft: the requirement, now choosing the saved
// pack, and the saved pack's ref, to confirm it at the content shown.
export type CourseDraftSaved = { requirement: Requirement; ref: CourseRef };

// One answer per question, in order.
export type RequirementAnswers = string[];

export type RequirementQuestion = { text: string; answer: string };

export type PlanPackage = {
  title: string;
  description: string;
  module: string;
  tags: string[];
  priority: packageTypes.Priority;
  estimateHours: number;
  icon: string;
  steps: string[];
  fileScope: string[];
  acceptance: AcceptanceCriterion[];
  difficulty?: packageTypes.PackageDifficulty;
  recommendedMode?: packageTypes.ModeRecommendation;
  // 1-based numbers of earlier packages; absent on plans saved before it existed.
  dependsOn?: number[];
  // Concept ids of the pack's skeleton; absent when none were tagged.
  concepts?: string[];
};

// course: the pack it was planned with; absent on older plans (programming).
export type RequirementPlan = { summary: string; packages: PlanPackage[]; course?: CourseRef };

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
  | { summary: InterfaceSummary; text: string; read: { path: string; sha: string }[]; skipped: packageTypes.SkippedFile[]; error: null }
  | { summary: null; text: null; read: { path: string; sha: string }[]; skipped: packageTypes.SkippedFile[]; error: ErrorInfo | null };

export type Requirement = {
  id: string;
  // Absent on requirements from before course mode: a project.
  kind?: RequirementKind;
  status: RequirementStatus;
  title: string;
  text: string;
  summary: string | null;
  questions: RequirementQuestion[];
  plan: RequirementPlan | null;
  // Published task definitions.
  packages: packageTypes.TaskDefinition[];
  interfaces: RequirementInterfaces | null;
  phase: RequirementPhase | null;
  error: ErrorInfo | null;
  failedStep: RequirementStep | null;
  costUsd: number;
  createdAt: string;
  updatedAt: string;
  course?: CourseInterview;
};

export const requirementsContract = {
  list: invoke<[], Requirement[]>('requirements:list'),
  get: invoke<[id: string], Requirement>('requirements:get'),
  create: invoke<[input: RequirementInput], Requirement>('requirements:create'),
  clarify: invoke<[id: string], Requirement>('requirements:clarify'),
  answer: invoke<[id: string, answers: RequirementAnswers], Requirement>('requirements:answer'),
  plan: invoke<[id: string, answers?: RequirementAnswers, choice?: CourseChoice], Requirement>('requirements:plan'),
  publish: invoke<[id: string], Requirement>('requirements:publish'),
  remove: invoke<[id: string], true>('requirements:remove'),
  cancel: invoke<[id: string], boolean>('requirements:cancel'),
  coursePath: invoke<[id: string, path: PathEntry[]], Requirement>('requirements:course-path'),
  courseSaveDraft: invoke<[id: string, pack: CoursePack], CourseDraftSaved>('requirements:course-save-draft'),
  courseConfirmDraft: invoke<[id: string, contentHash: string], Requirement>('requirements:course-confirm-draft'),
  // What generating the first lab covers and roughly costs; nothing runs.
  // `conceptId` picks another concept still to learn, after a needs_review self-check.
  labEstimate: invoke<[id: string, conceptId?: string], LabEstimate>('requirements:lab-estimate'),
  // Starts generating and self-checking the first lab after the learner saw the estimate.
  labGenerate: invoke<[id: string, conceptId?: string], Requirement>('requirements:lab-generate'),
  // Marks a concept still to learn skipped after the path was confirmed.
  courseSkip: invoke<[id: string, conceptId: string], Requirement>('requirements:course-skip'),
  // Writes the lab whose self-check passed into the lab repository; the
  // first one creates it in `root`, an empty folder, and opens it.
  labPlace: invoke<[id: string, root?: string], Requirement>('requirements:lab-place'),
} satisfies Contract;
