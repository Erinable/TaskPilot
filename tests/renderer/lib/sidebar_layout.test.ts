import { describe, expect, test } from 'vitest';

import * as layout from '../../../src/renderer/src/lib/sidebar_layout.ts';

describe('sidebar layout', () => {
  test('a drag resizes within bounds and folds to the rail past the threshold', () => {
    expect(layout.dragSidebar(280)).toEqual({ collapsed: false, width: 280 });
    expect(layout.dragSidebar(150)).toEqual({ collapsed: false, width: layout.MIN_SIDEBAR_WIDTH });
    expect(layout.dragSidebar(900)).toEqual({ collapsed: false, width: layout.MAX_SIDEBAR_WIDTH });
    expect(layout.dragSidebar(layout.COLLAPSE_BELOW - 1)).toEqual({ collapsed: true, width: null });
  });

  test('a stored width is clamped; anything unreadable is the default', () => {
    expect(layout.storedSidebarWidth('300')).toBe(300);
    expect(layout.storedSidebarWidth('9999')).toBe(layout.MAX_SIDEBAR_WIDTH);
    expect(layout.storedSidebarWidth('abc')).toBe(layout.DEFAULT_SIDEBAR_WIDTH);
    expect(layout.storedSidebarWidth(null)).toBe(layout.DEFAULT_SIDEBAR_WIDTH);
  });
});
