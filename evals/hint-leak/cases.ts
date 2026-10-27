// Hint leak eval cases: the work packages of the Tutor grading eval that have
// a reference solution, one per task (four OS lab programs and the
// programming findByEmail package). Each brings its committed fixture, the
// task Tutor helps with and the reference written over the fixture, so the
// reference patch is a real `git diff` like the one practice.ts stores.
import { cases as gradeCases } from '../tutor-grade/cases.ts';
import type { TutorTask } from '../../src/main/agents/tutor.ts';

export type LeakCase = {
  id: string;
  course: string;
  fixture: Record<string, string>;
  task: TutorTask;
  reference: Record<string, string>;
};

// One grading case per task; the others share its task and reference.
const FROM = ['os-pingpong-fds', 'os-copy-short-write', 'os-counter-volatile', 'os-bbuf-if-wait', 'pg-clean'];

export const cases: LeakCase[] = FROM.map((id) => {
  const source = gradeCases.find((testCase) => testCase.id === id);
  if (!source?.reference) throw new Error(`tutor-grade has no case ${id} with a reference`);
  return { id: id.replace(/^(os|pg)-([a-z]+).*$/, '$1-$2'), course: source.course, fixture: source.fixture, task: source.task, reference: source.reference };
});
