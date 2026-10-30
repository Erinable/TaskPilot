import { test } from 'vitest';
import assert from 'node:assert/strict';

import * as plans from '../../src/shared/course_plan.ts';
import type { Concept } from '../../src/shared/course_pack.ts';

const concept = (id: string, prerequisites: string[] = []): Concept => ({ id, label: id, summary: `${id}.`, prerequisites });
const SKELETON = [concept('process-state'), concept('fcfs', ['process-state']), concept('round-robin', ['fcfs'])];
const entry = (conceptId: string, status: plans.PathStatus = 'planned') => ({ conceptId, status });

test('goalFormProblem() names the field of the first problem', () => {
  const form = { level: 'basic', target: 'implement', toolchain: 'c', environment: 'macOS', weeklyHours: 4 };
  assert.equal(plans.goalFormProblem(form), null);
  assert.equal(plans.goalFormProblem({ ...form, level: 'expert' })?.field, 'goal.level');
  assert.equal(plans.goalFormProblem({ ...form, target: 'x' })?.field, 'goal.target');
  assert.equal(plans.goalFormProblem({ ...form, environment: null })?.field, 'goal.environment');
  assert.equal(plans.goalFormProblem({ ...form, environment: 'a\u0000b' })?.field, 'goal.environment');
  assert.equal(plans.goalFormProblem({ ...form, weeklyHours: 0 })?.field, 'goal.weeklyHours');
  assert.equal(plans.goalFormProblem({ ...form, weeklyHours: 2.5 })?.field, 'goal.weeklyHours');
  assert.equal(plans.goalFormProblem(null)?.field, 'goal.level');
});

test('pathProblem() refuses unknown, repeated and out-of-order concepts', () => {
  assert.equal(plans.pathProblem([entry('process-state', 'known'), entry('fcfs'), entry('round-robin')], SKELETON, []), null);
  // A prerequisite left off the path is taken as known.
  assert.equal(plans.pathProblem([entry('round-robin')], SKELETON, []), null);
  assert.match(plans.pathProblem([], SKELETON, [])!, /at least one/);
  assert.match(plans.pathProblem([entry('mlfq')], SKELETON, [])!, /"mlfq", which is not a concept/);
  assert.match(plans.pathProblem([entry('fcfs'), entry('fcfs')], SKELETON, [])!, /repeats "fcfs"/);
  assert.match(plans.pathProblem([entry('round-robin'), entry('fcfs')], SKELETON, [])!, /path\[0\] comes before its prerequisite "fcfs"/);
  assert.match(plans.pathProblem([{ conceptId: 'fcfs', status: 'done' as plans.PathStatus }], SKELETON, [])!, /status/);
});

test('orderPath() moves prerequisites first and keeps the rest of the order', () => {
  const ordered = plans.orderPath([entry('round-robin'), entry('process-state'), entry('fcfs')], SKELETON, []);
  assert.deepEqual(
    ordered.map((item) => item.conceptId),
    ['process-state', 'fcfs', 'round-robin'],
  );
});

test('extrasProblem() allows three ai: concepts with known prerequisites and no cycle', () => {
  assert.equal(plans.extrasProblem([concept('ai:mlfq-tuning', ['round-robin'])], SKELETON), null);
  assert.match(plans.extrasProblem([concept('mlfq')], SKELETON)!, /"ai:"/);
  assert.match(plans.extrasProblem([concept('ai:a'), concept('ai:b'), concept('ai:c'), concept('ai:d')], SKELETON)!, /more than 3/);
  assert.match(plans.extrasProblem([concept('ai:a', ['nope'])], SKELETON)!, /"nope"/);
  assert.match(plans.extrasProblem([concept('ai:a', ['ai:b']), concept('ai:b', ['ai:a'])], SKELETON)!, /cycle/);
  assert.match(plans.extrasProblem([concept('ai:a'), concept('ai:a')], SKELETON)!, /repeats/);
});

test('movedPath() refuses a move that puts a concept before its prerequisite', () => {
  const path = [entry('process-state'), entry('fcfs'), entry('round-robin')];
  assert.equal(plans.movedPath(path, 1, -1, SKELETON, []), null);
  assert.equal(plans.movedPath(path, 0, -1, SKELETON, []), null);
  const free = [entry('process-state'), entry('fcfs'), entry('ai:extra')];
  const moved = plans.movedPath(free, 2, -1, SKELETON, [concept('ai:extra', ['process-state'])]);
  assert.deepEqual(
    moved?.map((item) => item.conceptId),
    ['process-state', 'ai:extra', 'fcfs'],
  );
});
