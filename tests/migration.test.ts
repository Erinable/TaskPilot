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

test('renderer markup mounts the Vue app under the strict CSP', () => {
  const html = read('src/renderer/index.html');
  assert.match(html, /script-src 'self'; style-src 'self'/);
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
