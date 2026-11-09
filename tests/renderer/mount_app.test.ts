// Common Element Plus styles load with the app; styles for lazy-only controls
// load with every owner so they are available before its template renders.
// Picker theme overrides must survive a late vendor stylesheet.
import { globSync, readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { Window } from 'happy-dom';

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const mountApp = read('src/renderer/src/mount_app.ts');

const lazyControls = new Set(['date-picker', 'tree', 'segmented', 'input-number']);
const styleImports = (source: string) =>
  new Set([
    ...[...source.matchAll(/'element-plus\/es\/components\/([a-z-]+)\/style\/css'/g)].map((match) => match[1]),
    ...[...source.matchAll(/'element-plus\/theme-chalk\/el-([a-z-]+)\.css'/g)].map((match) => match[1]),
  ]);

test('every Element Plus control has its common or owning component style', () => {
  const common = styleImports(mountApp);
  for (const file of globSync('src/renderer/src/**/*.vue')) {
    const source = read(file);
    for (const [, name] of source.matchAll(/<el-([a-z-]+)/g)) {
      if (lazyControls.has(name)) {
        expect(common, `${name} stays outside startup CSS`).not.toContain(name);
        expect(styleImports(source), `${file} owns ${name}`).toContain(name);
      } else expect(common, `${file}: ${name}`).toContain(name);
    }
  }
  expect(common).toContain('message');
  expect(common).toContain('message-box');
  expect(mountApp).not.toMatch(/import ElementPlus|element-plus\/dist\/index\.css/);
});

for (const late of [true, false])
  test(`picker floating surface keeps the theme when vendor CSS loads ${late ? 'after' : 'before'} it`, async () => {
    const window = new Window();
    try {
      const document = window.document;
      document.documentElement.style.setProperty('--glass-border', 'rgb(12, 34, 56)');
      document.documentElement.style.setProperty('--glass-shadow', '0px 4px 8px rgb(12, 34, 56)');
      const theme = read('src/renderer/src/assets/element_theme.css');
      const vendor = read('node_modules/element-plus/theme-chalk/el-date-picker-panel.css');
      for (const source of late ? [theme, vendor] : [vendor, theme]) {
        const style = document.createElement('style');
        style.textContent = source;
        document.head.append(style);
      }
      const popper = document.createElement('div');
      popper.className = 'el-picker__popper el-popper is-light';
      document.body.append(popper);
      const style = window.getComputedStyle(popper);
      expect(style.border).toBe('1px solid rgb(12, 34, 56)');
      expect(style.boxShadow).toBe('0px 4px 8px rgb(12, 34, 56)');
    } finally {
      await window.close();
    }
  });

test('a picker also removes its stronger blur when transparency is reduced', async () => {
  const window = new Window();
  try {
    window.document.documentElement.style.setProperty('--glass-blur', 'blur(28px)');
    const style = window.document.createElement('style');
    // happy-dom has no reduced-transparency media feature. Activate the actual
    // reduction rule to check its cascade against the normal picker override.
    style.textContent = read('src/renderer/src/assets/element_theme.css').replace('(prefers-reduced-transparency: reduce)', 'all');
    window.document.head.append(style);
    const popper = window.document.createElement('div');
    popper.className = 'el-picker__popper el-popper is-light';
    window.document.body.append(popper);
    expect(window.getComputedStyle(popper).getPropertyValue('backdrop-filter')).toBe('none');
  } finally {
    await window.close();
  }
});

test('rarely used views load when first opened, not with the app', () => {
  const app = read('src/renderer/src/App.vue');
  for (const view of ['MapView', 'ActivityView', 'ReleaseView', 'TeamView', 'CostView', 'CourseView', 'NotesView', 'MasteryView']) {
    expect(app, view).not.toContain(`import ${view} from`);
    expect(app, view).toContain(`const ${view} = defineAsyncComponent(() => import('./views/${view}.vue'));`);
  }
});

test('settings loads in its own chunk and mounts only once it has been shown', () => {
  const app = read('src/renderer/src/App.vue');
  expect(app).not.toContain('import SettingsView from');
  expect(app).toContain("const loadSettingsView = () => import('./views/SettingsView.vue');");
  expect(app).toContain('<SettingsView v-if="settingsMounted" v-show="app.view === \'settings\'" />');
});
