// Pure helpers for the settings page: which pages have unsaved edits, and
// which nav entries match a search. No DOM access, so tests load this file
// directly.
//
// Loaded as a classic script in the renderer (window.TaskPilotSettingsModel)
// and as a CommonJS module in tests.
(function attach(root) {
  // Each page edits one slice of state, saved through one IPC call.
  const PAGE_STORES = {
    profile: 'preferences',
    preferences: 'preferences',
    environment: 'preferences',
    repository: 'workspace',
    commands: 'workspace',
    data: null, // actions only, nothing to save
  };

  /** Stable comparison for plain JSON-shaped values. */
  function sameValue(a, b) {
    return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
  }

  function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
    }
    return value;
  }

  /** Workspace form values, trimmed the way saving will trim them. */
  function workspaceDraft(form) {
    const commands = {};
    for (const [kind, line] of Object.entries(form.commands ?? {})) commands[kind] = (line ?? '').trim();
    return { root: (form.root ?? '').trim(), commands };
  }

  function preferencesDraft(prefs) {
    return {
      profile: { displayName: (prefs.profile?.displayName ?? '').trim(), avatarColor: prefs.profile?.avatarColor },
      appearance: { theme: prefs.appearance?.theme, vibrancy: prefs.appearance?.vibrancy === true },
      environment: { pathSource: prefs.environment?.pathSource },
    };
  }

  /**
   * Which stores have unsaved edits. `saved` and `draft` are
   * {preferences, workspace} in form shape.
   */
  function dirtyStores(saved, draft) {
    return {
      preferences: !sameValue(preferencesDraft(saved.preferences), preferencesDraft(draft.preferences)),
      workspace: !sameValue(workspaceDraft(saved.workspace), workspaceDraft(draft.workspace)),
    };
  }

  /**
   * Which individual pages hold unsaved edits, so the nav can mark exactly
   * the page that changed rather than every page sharing its store.
   */
  function dirtyPages(saved, draft) {
    const sp = preferencesDraft(saved.preferences);
    const dp = preferencesDraft(draft.preferences);
    const sw = workspaceDraft(saved.workspace);
    const dw = workspaceDraft(draft.workspace);
    return {
      profile: !sameValue(sp.profile, dp.profile),
      preferences: !sameValue(sp.appearance, dp.appearance),
      environment: !sameValue(sp.environment, dp.environment),
      repository: sw.root !== dw.root,
      commands: !sameValue(sw.commands, dw.commands),
      data: false,
    };
  }

  /**
   * Filters nav entries by a query, matching the label or its keywords,
   * case-insensitively. Returns the page ids that match, in order.
   */
  function matchPages(entries, query) {
    const terms = (query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return entries.map((entry) => entry.page);
    return entries
      .filter((entry) => {
        const haystack = `${entry.label} ${entry.keywords ?? ''}`.toLowerCase();
        return terms.every((term) => haystack.includes(term));
      })
      .map((entry) => entry.page);
  }

  /** Character count by code point, matching the main process's limit check. */
  function charCount(text) {
    return [...(text ?? '').trim()].length;
  }

  const api = { PAGE_STORES, sameValue, workspaceDraft, preferencesDraft, dirtyStores, dirtyPages, matchPages, charCount };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TaskPilotSettingsModel = api;
})(typeof window === 'undefined' ? globalThis : window);
