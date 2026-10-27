// Requirements and their plans (requirements:*).

import type { ErrorInfo } from './envelope.ts';
import type * as packageTypes from './packages.ts';
import type { AcceptanceCriterion } from './workspace.ts';
import type { Concept, CoursePack, CourseRef } from '../course_pack.ts';
import type { CoursePlan, GoalForm } from '../course_plan.ts';

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
  // The first lab's generation, once the path is confirmed; absent before.
  lab?: LabGeneration | null;
};

// What the learner sees of a lab being generated: never its code, solution,
// tests or hints, only their counts. `phase` is the call running: the
// statement and tests (spec), then the code.
export type LabGeneration = {
  status: 'running' | 'ready' | 'failed';
  phase: 'spec' | 'code' | null;
  concepts: string[];
  difficulty: packageTypes.Difficulty;
  startedAt: string;
  finishedAt: string | null;
  costUsd: number;
  lab: { id: string; title: string; summary: string; estimateHours: number; starterFiles: number; publicTests: number; hiddenTests: number } | null;
  error: ErrorInfo | null;
};

// requirements:lab-estimate: what generating the first lab would cover and
// roughly cost, shown before the learner confirms. `usd` is null when no
// price is known for the model (sync prices on the cost page).
export type LabEstimate = {
  concepts: { id: string; label: string }[];
  difficulty: packageTypes.Difficulty;
  calls: number;
  tokens: { input: number; output: number };
  model: string | null;
  usd: { low: number; high: number } | null;
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
