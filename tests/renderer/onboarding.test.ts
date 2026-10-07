import { describe, expect, test } from 'vitest';

import { buildSteps, isComplete } from '../../src/renderer/src/lib/onboarding.ts';
import type * as ipc from '../../src/shared/ipc_types.ts';

const repo = { configured: true, root: '/work/app', commit: 'abc', branch: 'main', dirty: false, changedFiles: 0 } as ipc.WorkspaceInfo;
const facts = (overrides = {}) => ({
  agent: { available: true, command: 'claude' },
  workspace: repo,
  testCommand: 'npm test',
  requirementCount: 1,
  ...overrides,
});
const state = (steps: ReturnType<typeof buildSteps>) =>
  Object.fromEntries(steps.map((step) => [step.id, step.done ? 'done' : step.waiting ? 'waiting' : 'todo']));

describe('onboarding steps', () => {
  test('a fresh install has everything to do, and later steps wait on the repository', () => {
    const steps = buildSteps(facts({ agent: { available: false, command: null }, workspace: { configured: false }, testCommand: '', requirementCount: 0 }));
    expect(state(steps)).toEqual({ cli: 'todo', repository: 'todo', checks: 'waiting', requirement: 'waiting' });
    expect(isComplete(steps)).toBe(false);
  });

  test('a requirement waits for the CLI even with a repository', () => {
    const steps = buildSteps(facts({ agent: { available: false, command: null }, requirementCount: 0 }));
    expect(state(steps)).toMatchObject({ checks: 'done', requirement: 'waiting' });
  });

  test('a blank test command does not count as set up', () => {
    expect(state(buildSteps(facts({ testCommand: '  ' }))).checks).toBe('todo');
  });

  test('everything done completes the checklist', () => {
    expect(isComplete(buildSteps(facts()))).toBe(true);
  });
});
