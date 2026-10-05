// User preferences: profile, appearance, and where verification commands get
// their PATH. Stored per machine in userData; nothing here is written to the
// repository or shared with anyone.
const fs = require('node:fs/promises');
const path = require('node:path');

const PREFERENCES_FILENAME = 'preferences.json';
const THEMES = ['system', 'light', 'dark'];
const AVATAR_COLORS = ['sunset', 'ocean', 'violet', 'forest', 'graphite'];
const PATH_SOURCES = ['inherit', 'login-shell'];
const MAX_NAME_LENGTH = 40;
// C0/C1 controls, plus bidi overrides that could visually reorder a name.
const DISALLOWED_NAME_CHARS = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/;

class PreferencesError extends Error {
  /** `field` names the settings input at fault. */
  constructor(message, code, field) {
    super(message);
    this.name = 'PreferencesError';
    this.code = code;
    if (field) this.field = field;
  }
}

function defaults() {
  return {
    profile: { displayName: '', avatarColor: 'sunset' },
    appearance: { theme: 'system', vibrancy: false },
    environment: { pathSource: 'inherit' },
  };
}

const codePoints = (text) => [...text].length;
const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);

function isValidName(name) {
  return codePoints(name) <= MAX_NAME_LENGTH && !DISALLOWED_NAME_CHARS.test(name);
}

/** Lenient: a hand-edited or older file falls back to defaults field by field. */
function normalize(raw) {
  const base = defaults();
  if (!raw || typeof raw !== 'object') return base;
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
}

/** Strict: a value from the settings form is rejected, never silently replaced. */
function validate(raw) {
  const fail = (message, code, field) => {
    throw new PreferencesError(message, code, field);
  };
  if (!raw || typeof raw !== 'object') fail('Preferences must be an object', 'invalid_preferences');

  const name = raw.profile?.displayName ?? '';
  if (typeof name !== 'string') fail('Display name must be text', 'invalid_name', 'displayName');
  const trimmed = name.trim();
  if (codePoints(trimmed) > MAX_NAME_LENGTH) {
    fail(`Display name is longer than ${MAX_NAME_LENGTH} characters`, 'name_too_long', 'displayName');
  }
  if (DISALLOWED_NAME_CHARS.test(trimmed)) fail('Display name contains control characters', 'invalid_name', 'displayName');

  const oneOf = (value, allowed, field) => {
    if (!allowed.includes(value)) fail(`Unknown ${field}: ${value}`, 'invalid_choice', field);
    return value;
  };
  if (typeof raw.appearance?.vibrancy !== 'boolean') fail('vibrancy must be a boolean', 'invalid_choice', 'vibrancy');

  return {
    profile: { displayName: trimmed, avatarColor: oneOf(raw.profile?.avatarColor, AVATAR_COLORS, 'avatarColor') },
    appearance: { theme: oneOf(raw.appearance?.theme, THEMES, 'theme'), vibrancy: raw.appearance.vibrancy },
    environment: { pathSource: oneOf(raw.environment?.pathSource, PATH_SOURCES, 'pathSource') },
  };
}

/** Avatar text: one CJK character, or up to two Latin initials. */
function initials(name) {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return '';
  const words = trimmed.split(/[\s._-]+/).filter(Boolean);
  const first = [...words[0]][0];
  if (/[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(first)) return first;
  const last = words.length > 1 ? [...words[words.length - 1]][0] : '';
  return (first + last).toUpperCase();
}

/** Preferences as the renderer sees them, with derived display values. */
function toView(preferences) {
  return { ...preferences, profile: { ...preferences.profile, initials: initials(preferences.profile.displayName) } };
}

async function load(configDir) {
  try {
    return normalize(JSON.parse(await fs.readFile(path.join(configDir, PREFERENCES_FILENAME), 'utf8')));
  } catch (error) {
    // A missing or corrupt file must not block startup.
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return defaults();
    throw error;
  }
}

/** Validates before writing, so a rejected value never reaches disk. */
async function save(configDir, raw) {
  const preferences = validate(raw);
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(path.join(configDir, PREFERENCES_FILENAME), `${JSON.stringify(preferences, null, 2)}\n`);
  return preferences;
}

module.exports = {
  PREFERENCES_FILENAME,
  THEMES,
  AVATAR_COLORS,
  PATH_SOURCES,
  MAX_NAME_LENGTH,
  PreferencesError,
  defaults,
  normalize,
  validate,
  initials,
  toView,
  load,
  save,
};
