// Pure helpers for the settings page: which pages have unsaved edits, and
// which nav entries match a search. No DOM access, so tests import it directly.
import type * as settingsTypes from '@shared/ipc/settings.ts';
import type * as workspaceTypes from '@shared/ipc/workspace.ts';

export type SettingsStore = 'preferences' | 'workspace';

// Each page edits one slice of state, saved through one IPC call.
export const PAGE_STORES = {
  profile: 'preferences',
  preferences: 'preferences',
  environment: 'preferences',
  agents: 'preferences',
  repository: 'workspace',
  commands: 'workspace',
  setup: null, // runs steps and writes commands through its own IPC
  data: null, // actions only, nothing to save
} as const satisfies Record<string, SettingsStore | null>;

export type SettingsPage = keyof typeof PAGE_STORES;

export const isSettingsPage = (page: string): page is SettingsPage => Object.hasOwn(PAGE_STORES, page);

// Preferences in the shape the form edits; extra fields (initials) are ignored.
export type PreferencesDraft = settingsTypes.PreferencesInput;

// Workspace form values; options may be partial, as the form holds them.
export type WorkspaceDraft = workspaceTypes.WorkspaceForm;

export type DraftPair = { preferences: PreferencesDraft; workspace: WorkspaceDraft };

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonical(record[key])]),
    );
  }
  return value;
};

// Stable comparison for plain JSON-shaped values.
export const sameValue = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

// Workspace form values, trimmed the way saving will trim them.
export const workspaceDraft = (form: WorkspaceDraft) => {
  const commands: Record<string, string> = {};
  for (const [kind, line] of Object.entries(form.commands ?? {})) commands[kind] = (line ?? '').trim();
  // Options only matter for a configured command; an empty line ignores them.
  const options: Record<string, { stage: workspaceTypes.CheckStage | undefined; blocking: boolean; reportPath: string }> = {};
  for (const [kind, value] of Object.entries(form.options ?? {})) {
    if (!commands[kind] || !value) continue;
    options[kind] = { stage: value.stage, blocking: value.blocking === true, reportPath: (value.reportPath ?? '').trim() };
  }
  return { root: (form.root ?? '').trim(), commands, options };
};

export const preferencesDraft = (prefs: Partial<PreferencesDraft>) => ({
  profile: { displayName: (prefs.profile?.displayName ?? '').trim(), avatarColor: prefs.profile?.avatarColor },
  appearance: { theme: prefs.appearance?.theme, vibrancy: prefs.appearance?.vibrancy === true },
  environment: { pathSource: prefs.environment?.pathSource },
  agents: prefs.agents,
  coding: prefs.coding,
});

// Which stores have unsaved edits.
export const dirtyStores = (saved: DraftPair, draft: DraftPair): Record<SettingsStore, boolean> => ({
  preferences: !sameValue(preferencesDraft(saved.preferences), preferencesDraft(draft.preferences)),
  workspace: !sameValue(workspaceDraft(saved.workspace), workspaceDraft(draft.workspace)),
});

// Which individual pages hold unsaved edits, so the nav can mark exactly
// the page that changed rather than every page sharing its store.
export const dirtyPages = (saved: DraftPair, draft: DraftPair): Partial<Record<SettingsPage, boolean>> => {
  const savedPrefs = preferencesDraft(saved.preferences);
  const draftPrefs = preferencesDraft(draft.preferences);
  const savedWorkspace = workspaceDraft(saved.workspace);
  const draftWorkspace = workspaceDraft(draft.workspace);
  return {
    profile: !sameValue(savedPrefs.profile, draftPrefs.profile),
    preferences: !sameValue(savedPrefs.appearance, draftPrefs.appearance),
    environment: !sameValue(savedPrefs.environment, draftPrefs.environment),
    // Coding isolation lives on the agents page.
    agents: !sameValue(savedPrefs.agents, draftPrefs.agents) || !sameValue(savedPrefs.coding, draftPrefs.coding),
    repository: savedWorkspace.root !== draftWorkspace.root,
    commands: !sameValue(savedWorkspace.commands, draftWorkspace.commands) || !sameValue(savedWorkspace.options, draftWorkspace.options),
    data: false,
  };
};

export type NavEntry<P extends string = string> = { page: P; label: string; keywords?: string };

// Filters nav entries by a query, matching the label or its keywords,
// case-insensitively. Returns the page ids that match, in order.
export const matchPages = <P extends string>(entries: NavEntry<P>[], query: string | null | undefined) => {
  const terms = (query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return entries.map((entry) => entry.page);
  return entries
    .filter((entry) => {
      const haystack = `${entry.label} ${entry.keywords ?? ''}`.toLowerCase();
      return terms.every((term) => haystack.includes(term));
    })
    .map((entry) => entry.page);
};

// Character count by code point, matching the main process's limit check.
export const charCount = (text: string | null | undefined) => [...(text ?? '').trim()].length;
