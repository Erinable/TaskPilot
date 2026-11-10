import { describe, expect, test } from 'vitest';

import { buildSteps, hasBlockingChecks, isComplete } from '../../../src/renderer/src/lib/onboarding.ts';
import type * as workspaceTypes from '../../../src/shared/ipc/workspace.ts';
import { agentStatus } from '../requirements_fakes.ts';

const repo = { configured: true, root: '/work/app', commit: 'abc', branch: 'main', dirty: false, changedFiles: 0 } as workspaceTypes.WorkspaceInfo;
const facts = (overrides = {}) => ({
  agent: agentStatus(),
  workspace: repo,
  checksReady: true,
  requirementCount: 1,
  ...overrides,
});
const state = (steps: ReturnType<typeof buildSteps>) =>
  Object.fromEntries(steps.map((step) => [step.id, step.done ? 'done' : step.waiting ? 'waiting' : 'todo']));
const missing = agentStatus({ available: false, command: null, signIn: null, coding: { cli: 'codex', installed: false, signIn: null } });

describe('onboarding steps', () => {
  test('a fresh install has everything to do, and later steps wait on the repository', () => {
    const steps = buildSteps(facts({ agent: missing, workspace: { configured: false }, checksReady: false, requirementCount: 0 }));
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

  test('missing effective blocking checks do not count as set up', () => {
    expect(state(buildSteps(facts({ checksReady: false }))).checks).toBe('todo');
  });

  test('learning uses Tutor and starts without a repository or project checks', () => {
    const agent = agentStatus({ available: false });
    agent.tutor = { ...agent.tutor, installed: true, available: true };
    const steps = buildSteps(facts({ path: 'course' as const, agent, workspace: { configured: false }, checksReady: false, courseRequirementCount: 0 }));
    expect(state(steps)).toEqual({ cli: 'done', requirement: 'todo' });
    expect(steps.find((step) => step.id === 'requirement')).toMatchObject({ action: '我想学…', waiting: false });
    expect(isComplete(buildSteps(facts({ path: 'course' as const, agent, courseRequirementCount: 1 })))).toBe(true);
  });

  test('mixed planning CLIs each have their own installation or sign-in help', () => {
    const agent = agentStatus();
    agent.analysis['product-lead'] = {
      ...agent.analysis['product-lead'],
      cli: 'pi',
      installed: false,
      available: false,
      signIn: null,
    };
    agent.analysis.architect = {
      ...agent.analysis.architect,
      cli: 'opencode',
      signIn: { state: 'signed_out', source: null },
    };
    const steps = buildSteps(facts({ agent, requirementCount: 0 }));
    expect(state(steps)).toMatchObject({ cli: 'todo', requirement: 'waiting' });
    const help = steps.find((step) => step.id === 'cli')!.help!;
    expect(help[0]).toMatchObject({ role: 'Product Lead', commands: ['npm install -g @earendil-works/pi-coding-agent', 'pi'] });
    expect(help[1]).toMatchObject({ role: 'Architect', commands: ['opencode auth login'] });
    expect(JSON.stringify(help)).not.toContain('Claude');
  });

  test('an installed incompatible CLI shows its reason instead of installation instructions', () => {
    const agent = agentStatus();
    agent.analysis.architect = { ...agent.analysis.architect, cli: 'opencode', available: false, reason: 'Requires OpenCode version 1.x' };
    const help = buildSteps(facts({ agent })).find((step) => step.id === 'cli')!.help![1];
    expect(help.ready).toBe(false);
    expect(help.detail).toContain('Requires OpenCode version 1.x');
    expect(help.commands).toEqual([]);
  });

  test('effective custom grading and other blocking submission checks count as ready', () => {
    const grade: workspaceTypes.StepView = {
      id: 'custom:grade',
      label: '评分',
      effective: { lines: ['make grade'], cwd: '', stage: 'submit', blocking: true, parser: { format: 'tests' }, timeoutSeconds: null },
      source: 'project',
      skipped: null,
      local: null,
      suggestions: [],
    };
    expect(hasBlockingChecks([grade])).toBe(true);
    expect(hasBlockingChecks([{ ...grade, id: 'build' }])).toBe(true);
    expect(hasBlockingChecks([{ ...grade, effective: null, skipped: 'disabled' }])).toBe(false);
    expect(hasBlockingChecks([{ ...grade, effective: { ...grade.effective!, blocking: false } }])).toBe(false);
    expect(hasBlockingChecks([{ ...grade, effective: { ...grade.effective!, stage: 'step' } }])).toBe(false);
    expect(hasBlockingChecks([{ ...grade, effective: { ...grade.effective!, lines: ['  '] } }])).toBe(false);
    expect(hasBlockingChecks([])).toBe(false);
  });

  test('everything done completes the checklist', () => {
    expect(isComplete(buildSteps(facts()))).toBe(true);
  });
});
