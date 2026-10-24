// Sidebar width rules: dragging its edge resizes it within bounds, and a
// drag far enough left folds it to the icon rail (as in VS Code).
export const DEFAULT_SIDEBAR_WIDTH = 236;
export const MIN_SIDEBAR_WIDTH = 200;
export const MAX_SIDEBAR_WIDTH = 360;
// Narrower than this while dragging collapses the sidebar.
export const COLLAPSE_BELOW = 140;

export const clampSidebarWidth = (width: number) => Math.round(Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width)));

// A stored width from localStorage; anything unreadable is the default.
export const storedSidebarWidth = (raw: string | null) => {
  const width = Number(raw);
  return raw !== null && Number.isFinite(width) ? clampSidebarWidth(width) : DEFAULT_SIDEBAR_WIDTH;
};

// Where a drag to `requested` px leaves the sidebar; a collapsed one keeps
// its last open width (width: null).
export const dragSidebar = (requested: number): { collapsed: boolean; width: number | null } =>
  requested < COLLAPSE_BELOW ? { collapsed: true, width: null } : { collapsed: false, width: clampSidebarWidth(requested) };
