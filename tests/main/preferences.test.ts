import { test, onTestFinished } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as preferences from '../../src/main/preferences.ts';

const tempDir = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'taskpilot-prefs-'));
  onTestFinished(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
};

const valid = (overrides: any = {}) => ({
  profile: { displayName: 'Ada Lovelace', avatarColor: 'ocean', ...overrides.profile },
  appearance: { theme: 'dark', vibrancy: false, ...overrides.appearance },
  environment: { pathSource: 'login-shell', ...overrides.environment },
  agents: preferences.defaults().agents,
  coding: preferences.defaults().coding,
});

test('load() returns defaults when the file is missing or corrupt', async () => {
  const dir = await tempDir();
  assert.deepEqual(await preferences.load(dir), preferences.defaults());
  await fs.writeFile(path.join(dir, preferences.PREFERENCES_FILENAME), '{ broken');
  assert.deepEqual(await preferences.load(dir), preferences.defaults());
});

test('save() then load() round-trips, trimming the name', async () => {
  const dir = await tempDir();
  const saved = await preferences.save(dir, valid({ profile: { displayName: '  Ada  ' } }));
  assert.equal(saved.profile.displayName, 'Ada');
  assert.deepEqual(await preferences.load(dir), saved);
});

test('normalize() replaces invalid fields with defaults one by one', () => {
  const result = preferences.normalize({
    profile: { displayName: 'x'.repeat(41), avatarColor: 'neon' },
    appearance: { theme: 'sepia', vibrancy: 'yes' },
    environment: { pathSource: 'login-shell' },
    extra: true,
  });
  assert.deepEqual(result, { ...preferences.defaults(), environment: { pathSource: 'login-shell' } });
});

test('validate() rejects bad values with the field they belong to', () => {
  const cases = [
    [valid({ profile: { displayName: 'x'.repeat(41) } }), 'name_too_long', 'displayName'],
    [valid({ profile: { displayName: 'bad\u0007name' } }), 'invalid_name', 'displayName'],
    [valid({ profile: { displayName: 'evil‮name' } }), 'invalid_name', 'displayName'],
    [valid({ profile: { avatarColor: 'neon' } }), 'invalid_choice', 'avatarColor'],
    [valid({ appearance: { theme: 'sepia' } }), 'invalid_choice', 'theme'],
    [valid({ appearance: { vibrancy: 'true' } }), 'invalid_choice', 'vibrancy'],
    [valid({ environment: { pathSource: 'anything' } }), 'invalid_choice', 'pathSource'],
  ];
  for (const [input, code, field] of cases) {
    assert.throws(() => preferences.validate(input), { code, field }, `${code}/${field}`);
  }
});

test('the name limit counts characters, not UTF-16 units', () => {
  // 40 emoji are 80 UTF-16 units but 40 characters.
  assert.equal(preferences.validate(valid({ profile: { displayName: '😀'.repeat(40) } })).profile.displayName.length, 80);
});

test('save() does not write a rejected value', async () => {
  const dir = await tempDir();
  await assert.rejects(() => preferences.save(dir, valid({ appearance: { theme: 'sepia' } })), { field: 'theme' });
  await assert.rejects(() => fs.access(path.join(dir, preferences.PREFERENCES_FILENAME)));
});

test('separator-only names survive save and reload with empty avatar initials', async () => {
  const dir = await tempDir();
  await preferences.save(dir, valid({ profile: { displayName: '---' } }));
  const loaded = await preferences.load(dir);
  assert.equal(loaded.profile.displayName, '---');
  assert.equal(preferences.toView(loaded).profile.initials, '');
});

test('toView() adds initials without changing the stored shape', () => {
  const view = preferences.toView(valid());
  assert.equal(view.profile.initials, 'AL');
  assert.equal(view.profile.displayName, 'Ada Lovelace');
});

test('per-agent runtime choices survive disk reload without changing other roles', async () => {
  const dir = await tempDir();
  const input = valid();
  input.agents.architect = { cli: 'pi', model: 'openai/gpt-5', thinking: 'high' };
  input.agents['coding-agent'] = { cli: 'grok', model: 'grok-code', thinking: 'medium' };
  await preferences.save(dir, input);
  const loaded = await preferences.load(dir);
  assert.deepEqual(loaded.agents.architect, input.agents.architect);
  assert.deepEqual(loaded.agents['coding-agent'], input.agents['coding-agent']);
  assert.deepEqual(loaded.agents.qa, { cli: 'claude', model: '', thinking: 'default' });
});

test('legacy preferences gain independent default role configurations', async () => {
  const dir = await tempDir();
  const { agents: _agents, ...legacy } = valid();
  await fs.writeFile(path.join(dir, preferences.PREFERENCES_FILENAME), JSON.stringify(legacy));
  const loaded = await preferences.load(dir);
  loaded.agents.architect.model = 'changed';
  assert.equal(loaded.agents.qa.model, '');
  assert.equal(loaded.agents['coding-agent'].cli, 'codex');
});

test('saving rejects unsafe role capability and malformed model or thinking', async () => {
  const dir = await tempDir();
  const cases = [
    { cli: 'codex', model: '', thinking: 'default' },
    { cli: 'claude', model: '', thinking: 'off' },
    { cli: 'pi', model: '--tools=bash', thinking: 'high' },
    { cli: 'pi', model: 'model\n--flag', thinking: 'high' },
    { cli: 'pi', model: '', thinking: 'maximum' },
  ];
  for (const config of cases) {
    const input = { ...valid(), agents: { ...preferences.defaults().agents, qa: config } };
    await assert.rejects(preferences.save(dir, input), { code: 'invalid_choice' });
  }
  await assert.rejects(fs.access(path.join(dir, preferences.PREFERENCES_FILENAME)));
});

test('coding timeout: only the listed choices are saved, and a hand-edited file falls back to 30 minutes', () => {
  assert.equal(preferences.validate({ ...valid(), coding: { ...preferences.defaults().coding, timeoutMinutes: 120 } }).coding.timeoutMinutes, 120);
  for (const bad of [45, '30', 0, null]) {
    assert.throws(
      () => preferences.validate({ ...valid(), coding: { ...preferences.defaults().coding, timeoutMinutes: bad } }),
      { code: 'invalid_choice' },
      String(bad),
    );
  }
  assert.equal(preferences.normalize({ coding: { isolation: 'sandbox', timeoutMinutes: 999 } }).coding.timeoutMinutes, 30);
});
