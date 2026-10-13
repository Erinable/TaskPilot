// TaskPilot icon set: 24×24 line icons drawn with a 1.75 stroke. Rendered by
// AppIcon.vue as SVG elements, never from markup strings.
type ShapeTag = 'path' | 'circle' | 'rect' | 'line' | 'polyline';

export type IconDefinition = { filled?: boolean; shapes: [ShapeTag, Record<string, string | number>][] };

// Each icon is a list of [tag, attributes]. `filled` icons use fill instead
// of stroke, for shapes that read poorly as outlines at small sizes.
export const ICONS = {
  // Navigation and chrome
  search: {
    shapes: [
      ['circle', { cx: 11, cy: 11, r: 6.5 }],
      ['path', { d: 'm20 20-4.2-4.2' }],
    ],
  },
  bell: {
    shapes: [
      ['path', { d: 'M6 16v-5a6 6 0 1 1 12 0v5l1.5 2h-15z' }],
      ['path', { d: 'M10 20.5a2 2 0 0 0 4 0' }],
    ],
  },
  queue: {
    shapes: [
      ['path', { d: 'm12 3 9 4.5-9 4.5-9-4.5z' }],
      ['path', { d: 'm3 12 9 4.5 9-4.5' }],
      ['path', { d: 'm3 16.5 9 4.5 9-4.5' }],
    ],
  },
  map: {
    shapes: [
      ['circle', { cx: 6, cy: 6, r: 2.5 }],
      ['circle', { cx: 18, cy: 6, r: 2.5 }],
      ['circle', { cx: 12, cy: 18, r: 2.5 }],
      ['path', { d: 'M8.5 6h7M7.2 8.2l3.6 7.6M16.8 8.2l-3.6 7.6' }],
    ],
  },
  activity: { shapes: [['path', { d: 'M3 12h4l2.5-7 5 14L17 12h4' }]] },
  settings: {
    shapes: [
      ['path', { d: 'M4 7h9M17 7h3M4 17h3M11 17h9' }],
      ['circle', { cx: 15, cy: 7, r: 2 }],
      ['circle', { cx: 9, cy: 17, r: 2 }],
    ],
  },
  'chevron-down': { shapes: [['path', { d: 'm6 9 6 6 6-6' }]] },
  'chevron-right': { shapes: [['path', { d: 'm9 6 6 6-6 6' }]] },
  'arrow-left': { shapes: [['path', { d: 'M19 12H5M11 6l-6 6 6 6' }]] },
  'arrow-right': { shapes: [['path', { d: 'M5 12h14M13 6l6 6-6 6' }]] },
  plus: { shapes: [['path', { d: 'M12 5v14M5 12h14' }]] },
  more: {
    filled: true,
    shapes: [
      ['circle', { cx: 5.5, cy: 12, r: 1.6 }],
      ['circle', { cx: 12, cy: 12, r: 1.6 }],
      ['circle', { cx: 18.5, cy: 12, r: 1.6 }],
    ],
  },
  filter: { shapes: [['path', { d: 'M4 5.5h16l-6.2 7.3v5.7l-3.6 2v-7.7z' }]] },
  refresh: {
    shapes: [
      ['path', { d: 'M20 11a8 8 0 0 0-14.3-4.9L4 8' }],
      ['path', { d: 'M4 4v4h4' }],
      ['path', { d: 'M4 13a8 8 0 0 0 14.3 4.9L20 16' }],
      ['path', { d: 'M20 20v-4h-4' }],
    ],
  },
  spinner: { shapes: [['path', { d: 'M12 3a9 9 0 1 0 9 9' }]] },
  sparkle: { filled: true, shapes: [['path', { d: 'M12 3c.6 4.2 2.8 6.4 7 7-4.2.6-6.4 2.8-7 7-.6-4.2-2.8-6.4-7-7 4.2-.6 6.4-2.8 7-7z' }]] },
  bot: {
    shapes: [
      ['rect', { x: 4.5, y: 8, width: 15, height: 11, rx: 3 }],
      ['circle', { cx: 12, cy: 4, r: 1 }],
      ['path', { d: 'M12 5v3M9.5 16h5' }],
      ['circle', { cx: 9, cy: 12.5, r: 0.6 }],
      ['circle', { cx: 15, cy: 12.5, r: 0.6 }],
    ],
  },

  user: {
    shapes: [
      ['circle', { cx: 12, cy: 8, r: 3.75 }],
      ['path', { d: 'M4.5 20a7.5 7.5 0 0 1 15 0' }],
    ],
  },
  sliders: {
    shapes: [
      ['path', { d: 'M5 4v6M5 14v6M12 4v3M12 11v9M19 4v9M19 17v3' }],
      ['path', { d: 'M3 12h4M10 9h4M17 15h4' }],
    ],
  },
  laptop: {
    shapes: [
      ['rect', { x: 4.5, y: 5, width: 15, height: 10.5, rx: 1.5 }],
      ['path', { d: 'M2.5 19h19' }],
    ],
  },
  monitor: {
    shapes: [
      ['rect', { x: 3, y: 4, width: 18, height: 12.5, rx: 2 }],
      ['path', { d: 'M8.5 20.5h7M12 16.5v4' }],
    ],
  },
  cpu: {
    shapes: [
      ['rect', { x: 6, y: 6, width: 12, height: 12, rx: 2 }],
      ['rect', { x: 9.5, y: 9.5, width: 5, height: 5, rx: 0.5 }],
      ['path', { d: 'M9.5 3v3M14.5 3v3M9.5 18v3M14.5 18v3M3 9.5h3M3 14.5h3M18 9.5h3M18 14.5h3' }],
    ],
  },
  database: {
    shapes: [
      ['path', { d: 'M4.5 6c0-1.7 3.4-3 7.5-3s7.5 1.3 7.5 3-3.4 3-7.5 3-7.5-1.3-7.5-3z' }],
      ['path', { d: 'M4.5 6v12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V6M4.5 12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3' }],
    ],
  },
  sun: {
    shapes: [
      ['circle', { cx: 12, cy: 12, r: 4 }],
      ['path', { d: 'M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4' }],
    ],
  },
  moon: { shapes: [['path', { d: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z' }]] },
  trash: {
    shapes: [
      ['path', { d: 'M4 7h16M9.5 7V4.5h5V7' }],
      ['path', { d: 'M6 7l1 12.5a1.5 1.5 0 0 0 1.5 1.5h7a1.5 1.5 0 0 0 1.5-1.5L18 7M10 11v6M14 11v6' }],
    ],
  },

  // Status and feedback
  check: { shapes: [['path', { d: 'm5 12.5 4.5 4.5L19 7.5' }]] },
  x: { shapes: [['path', { d: 'M6 6l12 12M18 6 6 18' }]] },
  circle: { shapes: [['circle', { cx: 12, cy: 12, r: 8 }]] },
  'check-circle': {
    shapes: [
      ['circle', { cx: 12, cy: 12, r: 9 }],
      ['path', { d: 'm8 12.5 2.8 2.8 5.7-5.8' }],
    ],
  },
  'x-circle': {
    shapes: [
      ['circle', { cx: 12, cy: 12, r: 9 }],
      ['path', { d: 'm9 9 6 6M15 9l-6 6' }],
    ],
  },
  alert: {
    shapes: [
      ['path', { d: 'M10.3 4.2 2.9 17.5a2 2 0 0 0 1.7 3h14.8a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z' }],
      ['path', { d: 'M12 9.5v4M12 17h.01' }],
    ],
  },
  info: {
    shapes: [
      ['circle', { cx: 12, cy: 12, r: 9 }],
      ['path', { d: 'M12 11v5.5M12 7.5h.01' }],
    ],
  },
  clock: {
    shapes: [
      ['circle', { cx: 12, cy: 12, r: 8.5 }],
      ['path', { d: 'M12 7.5V12l3 2' }],
    ],
  },
  'trend-up': {
    shapes: [
      ['path', { d: 'm3 17 6-6 4 4 8-8' }],
      ['path', { d: 'M15 7h6v6' }],
    ],
  },
  inbox: {
    shapes: [
      ['path', { d: 'M3.5 13.5 6 5.5h12l2.5 8V18a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z' }],
      ['path', { d: 'M3.5 13.5H8l1.5 2.5h5l1.5-2.5h4.5' }],
    ],
  },

  // Work package actions
  play: { filled: true, shapes: [['path', { d: 'M8 5.5v13l10.5-6.5z' }]] },
  send: {
    shapes: [
      ['path', { d: 'M21 3 10 14' }],
      ['path', { d: 'm21 3-6.5 18-4.5-7-7-4.5z' }],
    ],
  },
  flag: {
    shapes: [
      ['path', { d: 'M5 21V4' }],
      ['path', { d: 'M5 4.5h11l-2 4 2 4H5' }],
    ],
  },
  ban: {
    shapes: [
      ['circle', { cx: 12, cy: 12, r: 8.5 }],
      ['path', { d: 'm6 6 12 12' }],
    ],
  },
  unlock: {
    shapes: [
      ['rect', { x: 5, y: 10.5, width: 14, height: 10, rx: 2 }],
      ['path', { d: 'M8 10.5V7a4 4 0 0 1 7.7-1.5' }],
    ],
  },
  undo: {
    shapes: [
      ['path', { d: 'M9 14 4 9l5-5' }],
      ['path', { d: 'M4 9h10.5a5.5 5.5 0 0 1 0 11H11' }],
    ],
  },

  // Execution page sections
  'list-checks': {
    shapes: [
      ['path', { d: 'm4 6 1.5 1.5L8 5M4 12l1.5 1.5L8 11M4 18l1.5 1.5L8 17' }],
      ['path', { d: 'M11.5 6.5H20M11.5 12.5H20M11.5 18.5H20' }],
    ],
  },
  file: {
    shapes: [
      ['path', { d: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z' }],
      ['path', { d: 'M14 3v5h5' }],
    ],
  },
  folder: { shapes: [['path', { d: 'M3.5 7.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z' }]] },
  terminal: {
    shapes: [
      ['rect', { x: 3, y: 4.5, width: 18, height: 15, rx: 2.5 }],
      ['path', { d: 'm7 9.5 3 2.5-3 2.5M12.5 15H17' }],
    ],
  },
  diff: {
    shapes: [
      ['circle', { cx: 6, cy: 6, r: 2.5 }],
      ['circle', { cx: 18, cy: 18, r: 2.5 }],
      ['path', { d: 'M6 8.5V14a4 4 0 0 0 4 4h5.5M18 15.5V10a4 4 0 0 0-4-4H8.5' }],
    ],
  },
  'git-branch': {
    shapes: [
      ['circle', { cx: 6, cy: 5.5, r: 2 }],
      ['circle', { cx: 6, cy: 18.5, r: 2 }],
      ['circle', { cx: 18, cy: 7.5, r: 2 }],
      ['path', { d: 'M6 7.5v9M18 9.5v1a5 5 0 0 1-5 5H8' }],
    ],
  },
  commit: {
    shapes: [
      ['circle', { cx: 12, cy: 12, r: 3.5 }],
      ['path', { d: 'M3 12h5.5M15.5 12H21' }],
    ],
  },
  copy: {
    shapes: [
      ['rect', { x: 8.5, y: 8.5, width: 12, height: 12, rx: 2 }],
      ['path', { d: 'M15.5 8.5V5.5a2 2 0 0 0-2-2h-8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3' }],
    ],
  },

  // Verification kinds
  flask: {
    shapes: [
      ['path', { d: 'M9 3h6M10 3v6.5l-5.2 8.7a1.8 1.8 0 0 0 1.5 2.8h11.4a1.8 1.8 0 0 0 1.5-2.8L14 9.5V3' }],
      ['path', { d: 'M7.5 15h9' }],
    ],
  },
  wand: { shapes: [['path', { d: 'm4 20 10-10M14 4v3M17.5 6.5l-2 2M20 10h-3M12.5 5.5l2 2' }]] },
  box: {
    shapes: [
      ['path', { d: 'm12 3 8 4.5v9L12 21l-8-4.5v-9z' }],
      ['path', { d: 'm4 7.5 8 4.5 8-4.5M12 12v9' }],
    ],
  },

  // Work package kinds (referenced by tasks.js `icon`)
  key: {
    shapes: [
      ['circle', { cx: 8, cy: 15, r: 4 }],
      ['path', { d: 'm11 12 8.5-8.5M16 7l2.5 2.5M14 9l2 2' }],
    ],
  },
  blocks: {
    shapes: [
      ['rect', { x: 3.5, y: 3.5, width: 7, height: 7, rx: 1.5 }],
      ['rect', { x: 13.5, y: 3.5, width: 7, height: 7, rx: 1.5 }],
      ['rect', { x: 3.5, y: 13.5, width: 7, height: 7, rx: 1.5 }],
      ['path', { d: 'M17 13.5v7M13.5 17h7' }],
    ],
  },
  coins: {
    shapes: [
      ['circle', { cx: 9, cy: 9, r: 5.5 }],
      ['path', { d: 'M18.1 10.5a5.5 5.5 0 1 1-7.6 7.6' }],
      ['path', { d: 'M9 6.5v5M7.5 8h2.25a1 1 0 0 1 0 2H8.25a1 1 0 0 0 0 2H10.5' }],
    ],
  },
  rocket: {
    shapes: [
      ['path', { d: 'M12 15.5 8.5 12C10 7 13.5 3.8 20 4c.2 6.5-3 10-8 11.5z' }],
      ['path', { d: 'M8.5 12 5 11.5l2.5-3H11M12 15.5l.5 3.5 3-2.5V13' }],
      ['circle', { cx: 15, cy: 9, r: 1.5 }],
      ['path', { d: 'M5.5 18.5c.3-1.6 1-2.4 2.5-2.5-.1 1.5-.9 2.2-2.5 2.5z' }],
    ],
  },
  sidebar: {
    shapes: [
      ['rect', { x: 3.5, y: 4.5, width: 17, height: 15, rx: 2.5 }],
      ['path', { d: 'M9.5 4.5v15' }],
    ],
  },
  'external-link': {
    shapes: [
      ['path', { d: 'M13.5 4.5h6v6M19.5 4.5l-8 8' }],
      ['path', { d: 'M17.5 13.5v4.5a1.5 1.5 0 0 1-1.5 1.5H6a1.5 1.5 0 0 1-1.5-1.5V8A1.5 1.5 0 0 1 6 6.5h4.5' }],
    ],
  },
} satisfies Record<string, IconDefinition>;

export type IconName = keyof typeof ICONS;
