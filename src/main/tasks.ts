// Work package definitions. The queue holds only packages Product Lead
// generated and the user published from the requirement center; there are no
// built-in samples. Inline code in `steps` is marked with backticks and
// rendered as <code>.
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
}

// The part of a definition Architect can replan.
export type TaskRevisionDefinition = Pick<TaskDefinition, 'steps' | 'fileScope' | 'acceptance'>;

export interface FileScopeCheck {
  inScope: string[];
  outOfScope: string[];
  untouched: string[];
}

// Work packages Product Lead generated and the user published. Set by the
// main process from the requirement store; every caller of
// listTasks()/getTask() reads them from here.
let generated: TaskDefinition[] = [];

// Replaces the generated package list (see ./requirement_store.js).
export const setGeneratedTasks = (definitions: TaskDefinition[] | null | undefined) => {
  generated = structuredClone(definitions ?? []);
};

export const listTasks = (): TaskDefinition[] => {
  // Return a copy so callers can't mutate the shared data.
  return structuredClone(generated);
};

export const getTask = (id: string): TaskDefinition | null => {
  const task = generated.find((candidate) => candidate.id === id);
  return task ? structuredClone(task) : null;
};

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
