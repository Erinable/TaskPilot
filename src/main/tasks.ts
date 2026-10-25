// Work package definitions. The queue holds only packages Product Lead
// generated and the user published from the requirement center; there are no
// built-in samples. Inline code in `steps` is marked with backticks and
// rendered as <code>.
import type { ModeRecommendation, PackageDifficulty } from '../shared/ipc/packages.ts';
import type { WorkPackageStatus } from './work_package_status.ts';
import { isInside } from './workspace.ts';

export const PRIORITIES = ['high', 'medium', 'low'] as const;

export type Priority = (typeof PRIORITIES)[number];

// One acceptance criterion; `test` links it to a test result by name.
export interface AcceptanceCriterion {
  text: string;
  test?: string;
}

// A work package as the AI team authored it (see ./work_package_store.ts for
// the runtime state of executing it).
export interface TaskDefinition {
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
  steps: string[];
  fileScope: string[];
  acceptance: AcceptanceCriterion[];
  // Absent on packages planned before difficulty existed.
  difficulty?: PackageDifficulty;
  // Whether to practise it or hand it to Coding Agent. Absent on packages
  // planned before modes existed.
  recommendedMode?: ModeRecommendation;
  // Ids of packages from the same requirement that must be done first.
  // Absent on packages planned before dependencies existed.
  dependsOn?: string[];
  // The plan's estimate as a number; older packages only have `estimate`.
  estimateHours?: number;
  // The requirement it was planned from (see ./agents/product_lead.ts).
  // Absent on packages planned before it was recorded.
  requirementId?: string;
}

// The part of a definition Architect can replan.
export type TaskRevisionDefinition = Pick<TaskDefinition, 'steps' | 'fileScope' | 'acceptance'>;

export interface FileScopeCheck {
  inScope: string[];
  outOfScope: string[];
  untouched: string[];
}

// The published work package definitions, read-only. RequirementStore is the
// one implementation (see ./requirement_store.ts): it rebuilds the view when
// requirements are opened, published or removed. Entries are frozen and shared,
// so reads never copy; spread one to change it.
export interface TaskCatalog {
  listTasks(): readonly TaskDefinition[];
  getTask(id: string): TaskDefinition | null;
}

// For an app run without requirements.
export const EMPTY_CATALOG: TaskCatalog = { listTasks: () => [], getTask: () => null };

// Compares changed paths against a work package's file scope.
// Paths outside the scope are not an error — they are a signal that the
// breakdown was wrong, so the UI surfaces them for the human to judge.
export const checkFileScope = (task: Pick<TaskDefinition, 'fileScope'>, changedPaths: string[]): FileScopeCheck => {
  const scope = task.fileScope ?? [];
  const inScope: string[] = [];
  const outOfScope: string[] = [];
  for (const changed of changedPaths) {
    (scope.includes(changed) ? inScope : outOfScope).push(changed);
  }
  return {
    inScope,
    outOfScope,
    untouched: scope.filter((p) => !changedPaths.includes(p)),
  };
};

// Rejects a scope entry that would reach outside the workspace root.
export const scopeEscapesRoot = (root: string, task: Pick<TaskDefinition, 'fileScope'>): string[] =>
  (task.fileScope ?? []).filter((candidate) => !isInside(root, candidate));
