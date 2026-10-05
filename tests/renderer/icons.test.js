const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ICONS, createIcon } = require('../../src/renderer/icons');
const { listTasks } = require('../../src/tasks');

const RENDERER = path.join(__dirname, '..', '..', 'src', 'renderer');
const read = (file) => fs.readFileSync(path.join(RENDERER, file), 'utf8');

// A minimal stand-in for the DOM APIs createIcon touches.
function fakeDocument() {
  const make = (tag) => ({
    tag,
    attributes: {},
    children: [],
    setAttribute(key, value) { this.attributes[key] = value; },
    append(child) { this.children.push(child); },
  });
  return { createElementNS: (_ns, tag) => make(tag) };
}

for (const file of ['settings.js', 'requirements.js']) {
  test(`every icon name ${file} passes literally is defined`, () => {
    const source = read(file);
    const patterns = [/\bicon\('([^']+)'/g, /withIcon\([^,]+,\s*[^,]+,\s*'([^']+)'/g, /emptyHint\('([^']+)'/g, /iconName: '([^']+)'/g];
    const names = new Set();
    for (const pattern of patterns) for (const match of source.matchAll(pattern)) names.add(match[1]);
    assert.ok(names.size > 0, `expected icon references in ${file}`);
    for (const name of names) assert.ok(ICONS[name], `${file} uses unknown icon "${name}"`);
  });
}

test('every data-icon in the markup names a defined icon', () => {
  const names = [...read('index.html').matchAll(/data-icon="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(names.length > 20, 'expected the markup to use icons');
  for (const name of names) assert.ok(ICONS[name], `index.html uses unknown icon "${name}"`);
});

test('every icon name the renderer passes literally is defined', () => {
  const source = read('renderer.js');
  const patterns = [
    /\bicon\('([^']+)'/g, // icon('name')
    /withIcon\([^,]+,\s*[^,]+,\s*'([^']+)'/g, // withIcon(tag, class, 'name', ...)
    /emptyHint\('([^']+)'/g,
    /icon: '([^']+)'/g, // ACTIONS entries
  ];
  const names = new Set();
  for (const pattern of patterns) for (const match of source.matchAll(pattern)) names.add(match[1]);
  assert.ok(names.size > 15, `expected many icon references, found ${names.size}`);
  for (const name of names) assert.ok(ICONS[name], `renderer.js uses unknown icon "${name}"`);
});

test('icon names chosen at runtime by ternaries are defined', () => {
  // Names inside ternaries (e.g. ok ? 'check-circle' : 'x-circle') slip past
  // the literal patterns above, so list them here.
  for (const name of ['check-circle', 'x-circle', 'circle', 'alert', 'file', 'check', 'info']) {
    assert.ok(ICONS[name], `missing icon "${name}"`);
  }
});

test('every work package icon is defined', () => {
  for (const task of listTasks()) assert.ok(ICONS[task.icon], `${task.id} uses unknown icon "${task.icon}"`);
});

test('createIcon() builds an accessible-hidden SVG with stroke defaults', () => {
  const svg = createIcon(fakeDocument(), 'check', 'extra');
  assert.equal(svg.tag, 'svg');
  assert.equal(svg.attributes.viewBox, '0 0 24 24');
  assert.equal(svg.attributes['aria-hidden'], 'true');
  assert.equal(svg.attributes.class, 'icon extra');
  assert.equal(svg.attributes.stroke, 'currentColor');
  assert.equal(svg.attributes.fill, 'none');
  assert.equal(svg.children.length, ICONS.check.shapes.length);
});

test('createIcon() fills instead of strokes for filled icons', () => {
  const svg = createIcon(fakeDocument(), 'play');
  assert.equal(svg.attributes.fill, 'currentColor');
  assert.equal(svg.attributes.stroke, 'none');
  assert.equal(svg.attributes['stroke-width'], undefined);
});

test('createIcon() renders an empty box for an unknown name instead of throwing', () => {
  const svg = createIcon(fakeDocument(), 'no-such-icon');
  assert.equal(svg.children.length, 0);
  assert.equal(svg.attributes.class, 'icon');
});

test('icon geometry uses only plain SVG shapes and attributes', () => {
  // Shapes are built with setAttribute; keep them free of anything that could
  // carry script or external references.
  const allowedTags = new Set(['path', 'circle', 'rect', 'line', 'polyline']);
  const allowedAttributes = /^(d|cx|cy|r|x|y|width|height|rx|x1|y1|x2|y2|points)$/;
  for (const [name, definition] of Object.entries(ICONS)) {
    for (const [tag, attributes] of definition.shapes) {
      assert.ok(allowedTags.has(tag), `${name} uses <${tag}>`);
      for (const key of Object.keys(attributes)) assert.match(key, allowedAttributes, `${name} uses attribute ${key}`);
    }
  }
});
