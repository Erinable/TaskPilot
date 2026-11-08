// What the startup bundle (mount_app.ts and App.vue's static imports) holds.
// Element Plus components are imported on demand, so their styles are listed
// in mount_app.ts by hand: every el-* tag a template uses must have its style
// there, or it renders unstyled only in the built app.
import { globSync, readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const mountApp = read('src/renderer/src/mount_app.ts');

test('every Element Plus component a template uses has its style loaded before the theme', () => {
  const used = new Set(globSync('src/renderer/src/**/*.vue').flatMap((file) => [...read(file).matchAll(/<el-([a-z-]+)/g)].map((match) => match[1])));
  expect(used.size).toBeGreaterThan(0);
  const styled = new Set([...mountApp.matchAll(/'element-plus\/es\/components\/([a-z-]+)\/style\/css'/g)].map((match) => match[1]));
  expect([...used].filter((name) => !styled.has(name))).toEqual([]);
  // Toasts and confirm dialogs are called from lib/feedback.ts, not templates.
  expect(styled).toContain('message');
  expect(styled).toContain('message-box');
  expect(mountApp.lastIndexOf('/style/css')).toBeLessThan(mountApp.indexOf("import './assets/element_theme.css';"));
  // The whole library and its full stylesheet stay out.
  expect(mountApp).not.toMatch(/import ElementPlus|element-plus\/dist\/index\.css/);
});

test('rarely used views load when first opened, not with the app', () => {
  const app = read('src/renderer/src/App.vue');
  for (const view of ['MapView', 'ActivityView', 'ReleaseView', 'TeamView', 'CostView', 'CourseView', 'NotesView', 'MasteryView']) {
    expect(app, view).not.toContain(`import ${view} from`);
    expect(app, view).toContain(`const ${view} = defineAsyncComponent(() => import('./views/${view}.vue'));`);
  }
});
