// Requirements and their plans (requirements:*).

import type { ErrorInfo } from './envelope.ts';
import type * as packageTypes from './packages.ts';
import type { AcceptanceCriterion } from './workspace.ts';

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
  | { summary: InterfaceSummary; text: string; read: { path: string; sha: string }[]; skipped: packageTypes.SkippedFile[]; error: null }
  | { summary: null; text: null; read: { path: string; sha: string }[]; skipped: packageTypes.SkippedFile[]; error: ErrorInfo | null };

export type Requirement = {
  id: string;
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
};
