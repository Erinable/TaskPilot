// User preferences: profile, appearance, and where verification commands get
// their PATH. Stored per machine in userData; nothing here is written to the
// repository or shared with anyone.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { LooseJson } from './loose_json.ts';
import * as agentRuntime from '../shared/agent_runtime.ts';

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
  agents: agentRuntime.AgentSettings;
  coding: CodingIsolation;
}

// How the Coding Agent is kept away from the rest of the machine.
//   sandbox: the current user, inside TaskPilot's sandbox-exec profile
//   separate-user: the taskpilot-coder account, set up with a script
// Folders in extraRead/extraWrite are let into the sandbox; only sandbox
// mode reads them.
export const ISOLATIONS = ['sandbox', 'separate-user'] as const;
export type Isolation = (typeof ISOLATIONS)[number];
export type CodingIsolation = { isolation: Isolation; extraRead: string[]; extraWrite: string[] };
export const MAX_SANDBOX_FOLDERS = 20;

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
  agents: agentRuntime.defaultAgentSettings(),
  // [人工决策-2026-10-14] 新用户默认沙箱模式，独立账号模式作为更严的可选项。
  coding: { isolation: 'sandbox', extraRead: [], extraWrite: [] },
});

// A folder the user let into the sandbox. Never the file system root or the
// whole home folder: either would undo the sandbox.
const sandboxFolder = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !path.isAbsolute(value) || [...value].some((char) => (char.codePointAt(0) ?? 0) < 0x20) || value.length > 1024)
    throw new PreferencesError('Folder must be an absolute path', 'invalid_choice', field);
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root || resolved === os.homedir() || resolved === path.dirname(os.homedir()))
    throw new PreferencesError('This folder would open up the whole computer or home folder', 'invalid_choice', field);
  return resolved;
};

const sandboxFolders = (value: unknown, field: string, strict: boolean): string[] => {
  if (!Array.isArray(value)) {
    if (strict && value !== undefined) throw new PreferencesError('Folders must be a list', 'invalid_choice', field);
    return [];
  }
  if (value.length > MAX_SANDBOX_FOLDERS) {
    if (strict) throw new PreferencesError(`At most ${MAX_SANDBOX_FOLDERS} folders`, 'invalid_choice', field);
    value = value.slice(0, MAX_SANDBOX_FOLDERS);
  }
  const folders: string[] = [];
  for (const entry of value as unknown[]) {
    try {
      folders.push(sandboxFolder(entry, field));
    } catch (error) {
      if (strict) throw error;
    }
  }
  return [...new Set(folders)];
};

const codingIsolation = (value: unknown, strict: boolean): CodingIsolation => {
  const raw = (value && typeof value === 'object' ? value : {}) as LooseJson;
  if (strict && !ISOLATIONS.includes(raw.isolation)) throw new PreferencesError('Unknown isolation mode', 'invalid_choice', 'coding.isolation');
  return {
    isolation: pick(raw.isolation, ISOLATIONS, 'sandbox'),
    extraRead: sandboxFolders(raw.extraRead, 'coding.extraRead', strict),
    extraWrite: sandboxFolders(raw.extraWrite, 'coding.extraWrite', strict),
  };
};

const codePoints = (text: string) => [...text].length;
const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(value as T) ? (value as T) : fallback);

const isValidName = (name: string) => codePoints(name) <= MAX_NAME_LENGTH && !DISALLOWED_NAME_CHARS.test(name);

const agentConfig = (agent: agentRuntime.AgentId, value: unknown): agentRuntime.AgentRuntimeConfig => {
  const field = `agents.${agent}`;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PreferencesError('Agent settings must be an object', 'invalid_preferences', field);
  if (!('cli' in value) || !agentRuntime.CLI_IDS.includes(value.cli as agentRuntime.CliId))
    throw new PreferencesError('Unknown CLI', 'invalid_choice', `${field}.cli`);
  if (!('model' in value) || typeof value.model !== 'string') throw new PreferencesError('Model must be text', 'invalid_choice', `${field}.model`);
  const model = value.model.trim();
  if (model && !/^[A-Za-z0-9][A-Za-z0-9._:/@+*-]{0,199}$/.test(model))
    throw new PreferencesError('Model must be a model ID or provider/model (200 characters maximum)', 'invalid_choice', `${field}.model`);
  if (!('thinking' in value) || !agentRuntime.THINKING_LEVELS.includes(value.thinking as agentRuntime.ThinkingLevel))
    throw new PreferencesError('Unknown thinking level', 'invalid_choice', `${field}.thinking`);
  const config: agentRuntime.AgentRuntimeConfig = { cli: value.cli as agentRuntime.CliId, model, thinking: value.thinking as agentRuntime.ThinkingLevel };
  if (!agentRuntime.supportsAgentConfig(agent, config))
    throw new PreferencesError('This CLI or thinking level is not supported for this agent', 'invalid_choice', field);
  return config;
};

const agentSettings = (input: unknown, strict: boolean): agentRuntime.AgentSettings => {
  const settings = agentRuntime.defaultAgentSettings();
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    if (strict) throw new PreferencesError('Agent settings are required', 'invalid_preferences', 'agents');
    return settings;
  }
  for (const agent of agentRuntime.AGENT_IDS) {
    try {
      settings[agent] = agentConfig(agent, Reflect.get(input, agent));
    } catch (error) {
      if (strict) throw error;
    }
  }
  return settings;
};

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
    agents: agentSettings(raw.agents, false),
    coding: codingIsolation(raw.coding, false),
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
    agents: agentSettings(raw.agents, true),
    coding: codingIsolation(raw.coding, true),
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
