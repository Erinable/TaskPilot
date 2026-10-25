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

// How this machine treats a step: `inherit` runs whatever taskpilot.toml or
// the preset says, `override` runs the step as edited here, `off` turns it
// off here.
export type StepMode = 'inherit' | 'override' | 'off';

// One step as the form edits it: the form fields plus the mode.
export type StepDraft = workspaceTypes.StepForm & { mode: StepMode };

export type WorkspaceDraft = { root: string; steps: Partial<Record<workspaceTypes.CheckKind, StepDraft>> };

const DEFAULT_FORM: Omit<workspaceTypes.StepForm, 'stage' | 'blocking'> = {
  enabled: true,
  lines: [],
  cwd: '',
  parser: { format: 'tests' },
  timeoutSeconds: null,
};

// The draft of a step view: what this machine sets, else the effective
// values to start an override from.
export const stepDraft = (view: workspaceTypes.StepView): StepDraft => {
  if (view.local) return { ...view.local, lines: [...view.local.lines], mode: view.local.enabled ? 'override' : 'off' };
  const base = view.effective ?? { ...DEFAULT_FORM, stage: view.id === 'test' ? 'submit' : 'step', blocking: view.id === 'test' };
  return {
    enabled: true,
    lines: [...base.lines],
    cwd: base.cwd,
    stage: base.stage,
    blocking: base.blocking,
    parser: { ...base.parser },
    timeoutSeconds: base.timeoutSeconds,
    mode: 'inherit',
  };
};

// What saving sends: only the steps this machine sets.
export const workspaceForm = (draft: WorkspaceDraft): workspaceTypes.WorkspaceForm => {
  const steps: workspaceTypes.WorkspaceForm['steps'] = {};
  for (const [id, step] of Object.entries(draft.steps) as [workspaceTypes.CheckKind, StepDraft | undefined][]) {
    if (!step || step.mode === 'inherit') continue;
    const { mode, ...form } = step;
    steps[id] =
      mode === 'off' ? { ...form, enabled: false, lines: [] } : { ...form, enabled: true, lines: form.lines.map((line) => line.trim()).filter(Boolean) };
  }
  return { root: draft.root, steps };
};

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
  const saved = workspaceForm(form);
  return { root: (saved.root ?? '').trim(), steps: saved.steps };
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
    commands: !sameValue(savedWorkspace.steps, draftWorkspace.steps),
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
