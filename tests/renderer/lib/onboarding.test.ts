import { describe, expect, test } from 'vitest';

import { buildSteps, isComplete } from '../../../src/renderer/src/lib/onboarding.ts';
import type * as workspaceTypes from '../../../src/shared/ipc/workspace.ts';
import { agentStatus } from '../requirements_fakes.ts';

const repo = { configured: true, root: '/work/app', commit: 'abc', branch: 'main', dirty: false, changedFiles: 0 } as workspaceTypes.WorkspaceInfo;
const facts = (overrides = {}) => ({
  agent: agentStatus(),
  workspace: repo,
  testCommand: 'npm test',
  requirementCount: 1,
  ...overrides,
});
const state = (steps: ReturnType<typeof buildSteps>) =>
  Object.fromEntries(steps.map((step) => [step.id, step.done ? 'done' : step.waiting ? 'waiting' : 'todo']));
const missing = agentStatus({ available: false, command: null, signIn: null, coding: { cli: 'codex', installed: false, signIn: null } });

describe('onboarding steps', () => {
  test('a fresh install has everything to do, and later steps wait on the repository', () => {
    const steps = buildSteps(facts({ agent: missing, workspace: { configured: false }, testCommand: '', requirementCount: 0 }));
    expect(state(steps)).toEqual({ cli: 'todo', coding: 'todo', repository: 'todo', checks: 'waiting', requirement: 'waiting' });
    expect(isComplete(steps)).toBe(false);
  });

  test('an installed but signed-out CLI is not done, and says how to sign in', () => {
    const steps = buildSteps(facts({ agent: agentStatus({ signIn: { state: 'signed_out', source: null } }), requirementCount: 0 }));
    const cli = steps.find((step) => step.id === 'cli')!;
    expect(cli.done).toBe(false);
    expect(cli.title).toBe('登录 Claude Code');
    expect(cli.command).toBe('claude');
    expect(state(steps).requirement).toBe('waiting');
  });

  test('a CLI whose sign-in cannot be checked offline is not held back', () => {
    const steps = buildSteps(facts({ agent: agentStatus({ signIn: { state: 'unknown', source: null } }) }));
    expect(state(steps).cli).toBe('done');
  });

  test('the coding CLI is optional: it is shown, but never blocks the checklist', () => {
    const signedOut = agentStatus({ coding: { cli: 'codex', installed: true, signIn: { state: 'signed_out', source: null } } });
    const steps = buildSteps(facts({ agent: signedOut }));
    const coding = steps.find((step) => step.id === 'coding')!;
    expect(coding).toMatchObject({ done: false, optional: true, title: '登录 Codex（可选）', command: 'codex login' });
    expect(isComplete(steps)).toBe(true);
    const absent = buildSteps(facts({ agent: agentStatus({ coding: { cli: 'claude', installed: false, signIn: null } }) }));
    expect(absent.find((step) => step.id === 'coding')).toMatchObject({
      title: '安装 Claude Code（可选）',
      command: 'npm install -g @anthropic-ai/claude-code',
    });
  });

  test('a requirement waits for the CLI even with a repository', () => {
    const steps = buildSteps(facts({ agent: missing, requirementCount: 0 }));
    expect(state(steps)).toMatchObject({ checks: 'done', requirement: 'waiting' });
  });

  test('a blank test command does not count as set up', () => {
    expect(state(buildSteps(facts({ testCommand: '  ' }))).checks).toBe('todo');
  });

  test('everything done completes the checklist', () => {
    expect(isComplete(buildSteps(facts()))).toBe(true);
  });
});
