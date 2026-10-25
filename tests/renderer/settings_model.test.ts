import { test } from 'vitest';
import assert from 'node:assert/strict';

import * as model from '../../src/renderer/src/lib/settings_model.ts';
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
const ws = (overrides: Partial<workspaceTypes.WorkspaceForm> = {}): workspaceTypes.WorkspaceForm => ({
  root: '/repo',
  commands: { test: 'npm test', lint: '', build: '', smoke: '', ...overrides.commands },
  options: { ...overrides.options },
});

test('dirtyStores() is clean when nothing changed', () => {
  const saved = { preferences: prefs(), workspace: ws() };
  assert.deepEqual(model.dirtyStores(saved, structuredClone(saved)), { preferences: false, workspace: false });
});

test('dirtyStores() ignores whitespace that saving would trim', () => {
  const saved = { preferences: prefs(), workspace: ws() };
  const draft = {
    preferences: prefs({ profile: { displayName: '  Ada ' } }),
    workspace: ws({ root: '/repo  ', commands: { test: ' npm test', lint: '  ', build: '' } }),
  };
  assert.deepEqual(model.dirtyStores(saved, draft), { preferences: false, workspace: false });
});

test('dirtyStores() flags each store independently', () => {
  const saved = { preferences: prefs(), workspace: ws() };
  assert.deepEqual(model.dirtyStores(saved, { preferences: prefs({ appearance: { theme: 'dark' } }), workspace: ws() }), {
    preferences: true,
    workspace: false,
  });
  assert.deepEqual(model.dirtyStores(saved, { preferences: prefs(), workspace: ws({ commands: { test: 'npm test', lint: 'eslint .', build: '' } }) }), {
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
    workspace: ws({ commands: { test: 'npm test', lint: 'eslint .', build: '' } }),
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

test('changing a check option marks the commands page dirty, but not for an empty command', () => {
  const opts = (blocking: boolean): Partial<Record<workspaceTypes.CheckKind, Partial<workspaceTypes.CheckOptions>>> => ({
    test: { stage: 'submit', blocking, reportPath: '' },
    lint: { stage: 'step', blocking, reportPath: '' },
  });
  const saved = { preferences: prefs(), workspace: ws({ options: opts(true) }) };
  const changed = model.dirtyPages(saved, {
    preferences: prefs(),
    workspace: ws({ options: { ...opts(true), test: { stage: 'submit', blocking: false, reportPath: '' } } }),
  });
  assert.equal(changed.commands, true);
  // lint has no command, so toggling its options is not an edit.
  const ignored = model.dirtyPages(saved, {
    preferences: prefs(),
    workspace: ws({ options: { ...opts(true), lint: { stage: 'step', blocking: false, reportPath: '' } } }),
  });
  assert.equal(ignored.commands, false);
});
