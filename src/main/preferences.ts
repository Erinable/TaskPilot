// User preferences: profile, appearance, and where verification commands get
// their PATH. Stored per machine in userData; nothing here is written to the
// repository or shared with anyone.
import fs from 'node:fs/promises';
import path from 'node:path';
import type { LooseJson } from './loose_json.ts';

export const PREFERENCES_FILENAME = 'preferences.json';
export const THEMES = ['system', 'light', 'dark'] as const;
export const AVATAR_COLORS = ['sunset', 'ocean', 'violet', 'forest', 'graphite'] as const;
export const PATH_SOURCES = ['inherit', 'login-shell'] as const;
export const MAX_NAME_LENGTH = 40;
// C0/C1 controls, plus bidi overrides that could visually reorder a name.
// Display names refuse all C0/C1 controls and bidi overrides.
// eslint-disable-next-line no-control-regex
const DISALLOWED_NAME_CHARS = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/;

export type Theme = (typeof THEMES)[number];
export type AvatarColor = (typeof AVATAR_COLORS)[number];
// Where verification commands get their PATH.
export type PathSource = (typeof PATH_SOURCES)[number];

// Per-machine user preferences.
export interface Preferences {
  profile: { displayName: string; avatarColor: AvatarColor };
  appearance: { theme: Theme; vibrancy: boolean };
  environment: { pathSource: PathSource };
}

// Preferences as the renderer sees them, with derived display values.
export type PreferencesView = Preferences & { profile: Preferences['profile'] & { initials: string } };

export type PreferencesErrorCode = 'invalid_preferences' | 'invalid_name' | 'name_too_long' | 'invalid_choice';

export class PreferencesError extends Error {
  code: PreferencesErrorCode;
  field?: string;

  // `field` names the settings input at fault.
  constructor(message: string, code: PreferencesErrorCode, field?: string) {
    super(message);
    this.name = 'PreferencesError';
    this.code = code;
    if (field) this.field = field;
  }
}

export const defaults = (): Preferences => ({
  profile: { displayName: '', avatarColor: 'sunset' },
  appearance: { theme: 'system', vibrancy: false },
  environment: { pathSource: 'inherit' },
});

const codePoints = (text: string) => [...text].length;
const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(value as T) ? (value as T) : fallback);

const isValidName = (name: string) => codePoints(name) <= MAX_NAME_LENGTH && !DISALLOWED_NAME_CHARS.test(name);

// Lenient: a hand-edited or older file falls back to defaults field by field.
export const normalize = (input: unknown): Preferences => {
  const base = defaults();
  if (!input || typeof input !== 'object') return base;
  const raw = input as LooseJson;
  const name = typeof raw.profile?.displayName === 'string' ? raw.profile.displayName.trim() : '';
  return {
    profile: {
      displayName: isValidName(name) ? name : '',
      avatarColor: pick(raw.profile?.avatarColor, AVATAR_COLORS, base.profile.avatarColor),
    },
    appearance: {
      theme: pick(raw.appearance?.theme, THEMES, base.appearance.theme),
      vibrancy: raw.appearance?.vibrancy === true,
    },
    environment: {
      pathSource: pick(raw.environment?.pathSource, PATH_SOURCES, base.environment.pathSource),
    },
  };
};

// Strict: a value from the settings form is rejected, never silently replaced.
export const validate = (input: unknown): Preferences => {
  const fail = (message: string, code: PreferencesErrorCode, field?: string): never => {
    throw new PreferencesError(message, code, field);
  };
  if (!input || typeof input !== 'object') fail('Preferences must be an object', 'invalid_preferences');
  const raw = input as LooseJson;

  const name = raw.profile?.displayName ?? '';
  if (typeof name !== 'string') fail('Display name must be text', 'invalid_name', 'displayName');
  const trimmed = name.trim();
  if (codePoints(trimmed) > MAX_NAME_LENGTH) {
    fail(`Display name is longer than ${MAX_NAME_LENGTH} characters`, 'name_too_long', 'displayName');
  }
  if (DISALLOWED_NAME_CHARS.test(trimmed)) fail('Display name contains control characters', 'invalid_name', 'displayName');

  const oneOf = <T extends string>(value: unknown, allowed: readonly T[], field: string): T => {
    if (!allowed.includes(value as T)) fail(`Unknown ${field}: ${value}`, 'invalid_choice', field);
    return value as T;
  };
  if (typeof raw.appearance?.vibrancy !== 'boolean') fail('vibrancy must be a boolean', 'invalid_choice', 'vibrancy');

  return {
    profile: { displayName: trimmed, avatarColor: oneOf(raw.profile?.avatarColor, AVATAR_COLORS, 'avatarColor') },
    appearance: { theme: oneOf(raw.appearance?.theme, THEMES, 'theme'), vibrancy: raw.appearance.vibrancy },
    environment: { pathSource: oneOf(raw.environment?.pathSource, PATH_SOURCES, 'pathSource') },
  };
};

// Avatar text: one CJK character, or up to two Latin initials.
export const initials = (name: string | null | undefined): string => {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return '';
  const words = trimmed.split(/[\s._-]+/).filter(Boolean);
  const first = [...words[0]][0];
  if (/[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(first)) return first;
  const last = words.length > 1 ? [...words[words.length - 1]][0] : '';
  return (first + last).toUpperCase();
};

// Preferences as the renderer sees them, with derived display values.
export const toView = (preferences: Preferences): PreferencesView => ({
  ...preferences,
  profile: { ...preferences.profile, initials: initials(preferences.profile.displayName) },
});

export const load = async (configDir: string): Promise<Preferences> => {
  try {
    return normalize(JSON.parse(await fs.readFile(path.join(configDir, PREFERENCES_FILENAME), 'utf8')));
  } catch (error) {
    // A missing or corrupt file must not block startup.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return defaults();
    throw error;
  }
};

// Validates before writing, so a rejected value never reaches disk.
export const save = async (configDir: string, raw: unknown): Promise<Preferences> => {
  const preferences = validate(raw);
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(path.join(configDir, PREFERENCES_FILENAME), `${JSON.stringify(preferences, null, 2)}\n`);
  return preferences;
};
