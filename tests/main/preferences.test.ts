import { test, onTestFinished } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as preferences from '../../src/main/preferences.ts';

async function tempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'taskpilot-prefs-'));
  onTestFinished(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

const valid = (overrides: any = {}) => ({
  profile: { displayName: 'Ada Lovelace', avatarColor: 'ocean', ...overrides.profile },
  appearance: { theme: 'dark', vibrancy: false, ...overrides.appearance },
  environment: { pathSource: 'login-shell', ...overrides.environment },
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

test('initials() picks one CJK character or up to two Latin initials', () => {
  assert.equal(preferences.initials(''), '');
  assert.equal(preferences.initials('   '), '');
  assert.equal(preferences.initials('ada'), 'A');
  assert.equal(preferences.initials('Ada Lovelace'), 'AL');
  assert.equal(preferences.initials('ada byron lovelace'), 'AL');
  assert.equal(preferences.initials('han.guoliang'), 'HG');
  assert.equal(preferences.initials('韩国梁'), '韩');
  assert.equal(preferences.initials('😀 smile'), '😀S');
});

test('toView() adds initials without changing the stored shape', () => {
  const view = preferences.toView(valid());
  assert.equal(view.profile.initials, 'AL');
  assert.equal(view.profile.displayName, 'Ada Lovelace');
});
