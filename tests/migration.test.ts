import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const filesUnder = (dir: string): string[] =>
  fs
    .readdirSync(path.join(root, dir), { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory() ? filesUnder(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));

test('package metadata runs the electron-vite build output with Vitest', () => {
  const packageJson = JSON.parse(read('package.json'));
  assert.equal(packageJson.type, 'module');
  assert.equal(packageJson.main, 'out/main/index.js');
  assert.equal(packageJson.scripts.dev, 'electron-vite dev');
  assert.equal(packageJson.scripts.build, 'electron-vite build');
  assert.equal(packageJson.scripts.test, 'vitest run');
  // Every dependency is pinned to an exact version.
  for (const [name, version] of Object.entries({ ...packageJson.dependencies, ...packageJson.devDependencies })) {
    assert.match(String(version), /^\d+\.\d+\.\d+$/, `${name} is not pinned`);
  }
});

test('Electron entry loads the bundled CommonJS preload and the renderer', () => {
  const source = read('src/main/index.ts');
  assert.match(source, /path\.join\(import\.meta\.dirname, '\.\.', 'preload', 'index\.cjs'\)/);
  assert.match(source, /path\.join\(import\.meta\.dirname, '\.\.', 'renderer', 'index\.html'\)/);
  assert.match(read('electron.vite.config.ts'), /format: 'cjs', entryFileNames: '\[name\]\.cjs'/);
});

test('source is TypeScript and Vue only', () => {
  const stray = ['src', 'tests', 'evals'].flatMap(filesUnder).filter((file) => /\.(js|cjs|mjs)$/.test(file));
  assert.deepEqual(stray, []);
});

test('renderer markup mounts the Vue app under the strict CSP', () => {
  const html = read('src/renderer/index.html');
  assert.match(html, /script-src 'self'; style-src 'self'/);
  assert.match(html, /<div id="app"><\/div>/);
  assert.match(html, /<script type="module" src="\.\/src\/main\.ts"><\/script>/);
});

test('renderer never renders markup from strings', () => {
  for (const file of filesUnder('src/renderer/src')) {
    const source = read(file);
    assert.doesNotMatch(source, /v-html|innerHTML|insertAdjacentHTML|outerHTML/, file);
  }
});

// KaTeX builds formulas as DOM nodes; trusted mode would let \\href and \\html… through.
test('note formulas render with KaTeX untrusted', () => {
  const source = read('src/renderer/src/components/notes/NoteMath.vue');
  assert.match(source, /trust: false/);
  assert.doesNotMatch(source, /renderToString|trust: true/);
});

test('main-process source never contains CommonJS markers', () => {
  // electron-vite injects a CommonJS shim after the last import whenever the
  // bundle mentions these, and a match inside a string literal breaks the build.
  const marker = new RegExp(['__file' + 'name', '__dir' + 'name', 'require' + '\\('].join('|'));
  for (const file of [...filesUnder('src/main'), ...filesUnder('src/shared')]) {
    assert.doesNotMatch(read(file), marker, file);
  }
});
