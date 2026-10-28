import { test } from 'vitest';
import assert from 'node:assert/strict';

import * as model from '../../../src/renderer/src/lib/settings_model.ts';
import { defaultAgentSettings } from '@shared/agent_runtime.ts';
import type * as agentRuntimeTypes from '@shared/agent_runtime.ts';
import type * as settingsTypes from '@shared/ipc/settings.ts';
import type * as workspaceTypes from '@shared/ipc/workspace.ts';

type PreferenceOverrides = {
  profile?: Partial<{ displayName: string; avatarColor: settingsTypes.AvatarColor }>;
  appearance?: Partial<{ theme: settingsTypes.Theme; vibrancy: boolean }>;
  environment?: Partial<{ pathSource: settingsTypes.PathSource }>;
  agents?: agentRuntimeTypes.AgentSettings;
};
const prefs = (overrides: PreferenceOverrides = {}): settingsTypes.PreferencesInput => ({
  profile: { displayName: 'Ada', avatarColor: 'ocean', ...overrides.profile },
  appearance: { theme: 'system', vibrancy: false, ...overrides.appearance },
  environment: { pathSource: 'inherit', ...overrides.environment },
  agents: overrides.agents ?? defaultAgentSettings(),
  coding: { isolation: 'sandbox', extraRead: [], extraWrite: [], timeoutMinutes: 30 },
});
const step = (lines: string[], overrides: Partial<model.StepDraft> = {}): model.StepDraft => ({
  enabled: true,
  lines,
  cwd: '',
  stage: 'step',
  blocking: false,
  parser: { format: 'tests' },
  timeoutSeconds: null,
  mode: lines.length ? 'override' : 'inherit',
  ...overrides,
});
const ws = (overrides: { root?: string; steps?: model.WorkspaceDraft['steps'] } = {}): model.WorkspaceDraft => ({
  root: overrides.root ?? '/repo',
  steps: { test: step(['npm test'], { stage: 'submit', blocking: true }), lint: step([]), build: step([]), ...overrides.steps },
});

test('dirtyStores() is clean when nothing changed', () => {
  const saved = { preferences: prefs(), workspace: ws() };
  assert.deepEqual(model.dirtyStores(saved, structuredClone(saved)), { preferences: false, workspace: false });
});

test('dirtyStores() ignores whitespace that saving would trim', () => {
  const saved = { preferences: prefs(), workspace: ws() };
  const draft = {
    preferences: prefs({ profile: { displayName: '  Ada ' } }),
    workspace: ws({ root: '/repo  ', steps: { test: step([' npm test', '  '], { stage: 'submit', blocking: true }), lint: step([]) } }),
  };
  assert.deepEqual(model.dirtyStores(saved, draft), { preferences: false, workspace: false });
});

test('dirtyStores() flags each store independently', () => {
  const saved = { preferences: prefs(), workspace: ws() };
  assert.deepEqual(model.dirtyStores(saved, { preferences: prefs({ appearance: { theme: 'dark' } }), workspace: ws() }), {
    preferences: true,
    workspace: false,
  });
  assert.deepEqual(model.dirtyStores(saved, { preferences: prefs(), workspace: ws({ steps: { lint: step(['eslint .']) } }) }), {
    preferences: false,
    workspace: true,
  });
});

test('dirtyPages() marks only the page whose slice changed', () => {
  const saved = { preferences: prefs(), workspace: ws() };
  const onlyName = model.dirtyPages(saved, { preferences: prefs({ profile: { displayName: 'Grace' } }), workspace: ws() });
  assert.deepEqual(
    Object.entries(onlyName)
      .filter(([, dirty]) => dirty)
      .map(([page]) => page),
    ['profile'],
  );

  const onlyLint = model.dirtyPages(saved, {
    preferences: prefs(),
    workspace: ws({ steps: { lint: step(['eslint .']) } }),
  });
  assert.deepEqual(
    Object.entries(onlyLint)
      .filter(([, dirty]) => dirty)
      .map(([page]) => page),
    ['commands'],
  );
});
test('agent changes dirty only the agents page while sharing preferences save', () => {
  const saved = { preferences: prefs(), workspace: ws() };
  const agents = defaultAgentSettings();
  agents.qa.model = 'provider/model';
  const dirty = model.dirtyPages(saved, { preferences: prefs({ agents }), workspace: ws() });
  assert.equal(model.dirtyStores(saved, { preferences: prefs({ agents }), workspace: ws() }).preferences, true);
  assert.deepEqual(
    Object.entries(dirty)
      .filter(([, changed]) => changed)
      .map(([page]) => page),
    ['agents'],
  );
});

test('sameValue() does not depend on key order', () => {
  assert.ok(model.sameValue({ a: 1, b: { c: 2, d: 3 } }, { b: { d: 3, c: 2 }, a: 1 }));
  assert.ok(!model.sameValue({ a: [1, 2] }, { a: [2, 1] }));
});

test('matchPages() matches labels and keywords, every term required', () => {
  const entries = [
    { page: 'profile', label: '个人资料', keywords: '名字 头像 name avatar' },
    { page: 'preferences', label: '偏好设置', keywords: '主题 深色 theme dark' },
    { page: 'environment', label: '运行环境', keywords: 'PATH shell nvm' },
  ];
  assert.deepEqual(model.matchPages(entries, ''), ['profile', 'preferences', 'environment']);
  assert.deepEqual(model.matchPages(entries, '头像'), ['profile']);
  assert.deepEqual(model.matchPages(entries, 'DARK'), ['preferences']);
  assert.deepEqual(model.matchPages(entries, 'path nvm'), ['environment']);
  assert.deepEqual(model.matchPages(entries, 'path theme'), []);
});

test('charCount() counts code points after trimming', () => {
  assert.equal(model.charCount('  ab  '), 2);
  assert.equal(model.charCount('😀😀'), 2);
  assert.equal(model.charCount(undefined), 0);
});

test('a step option edit is dirty only for a step this machine sets', () => {
  const saved = { preferences: prefs(), workspace: ws() };
  const changed = model.dirtyPages(saved, {
    preferences: prefs(),
    workspace: ws({ steps: { test: step(['npm test'], { stage: 'submit', blocking: false }) } }),
  });
  assert.equal(changed.commands, true);
  // lint follows the project, so toggling its options saves nothing.
  const ignored = model.dirtyPages(saved, { preferences: prefs(), workspace: ws({ steps: { lint: step([], { blocking: true }) } }) });
  assert.equal(ignored.commands, false);
  // Turning a step off here is an edit.
  const off = model.dirtyPages(saved, { preferences: prefs(), workspace: ws({ steps: { lint: step([], { mode: 'off' }) } }) });
  assert.equal(off.commands, true);
});

test('workspaceForm() sends only the steps this machine sets', () => {
  const form = model.workspaceForm(ws({ steps: { lint: step([], { mode: 'off' }), build: step([' make ', '']) } }));
  assert.deepEqual(Object.keys(form.steps).sort(), ['build', 'lint', 'test']);
  assert.deepEqual(form.steps.lint, { enabled: false, lines: [], cwd: '', stage: 'step', blocking: false, parser: { format: 'tests' }, timeoutSeconds: null });
  assert.deepEqual(form.steps.build?.lines, ['make']);
});

test('stepDraft() starts an inherited step from what runs now', () => {
  const effective = {
    lines: ['npm run lint'],
    cwd: 'app',
    stage: 'submit' as const,
    blocking: true,
    parser: { format: 'exitcode' as const },
    timeoutSeconds: 60,
  };
  const view: workspaceTypes.StepView = { id: 'lint', label: null, effective, source: 'preset', skipped: null, local: null, suggestions: [] };
  assert.deepEqual(model.stepDraft(view), { enabled: true, ...effective, mode: 'inherit' });
  const local = { ...effective, enabled: false, lines: [] };
  assert.equal(model.stepDraft({ ...view, local }).mode, 'off');
});
