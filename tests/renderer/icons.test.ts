// @vitest-environment happy-dom
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mount } from '@vue/test-utils';

import AppIcon from '../../src/renderer/src/components/AppIcon.vue';
import { ICONS } from '../../src/renderer/src/lib/icons.ts';
import type { IconDefinition, IconName } from '../../src/renderer/src/lib/icons.ts';
import { listTasks } from '../../src/main/tasks.ts';

const SOURCE = path.join(import.meta.dirname, '..', '..', 'src', 'renderer', 'src');
const definitions = ICONS as Record<string, IconDefinition>;

const sourceFiles = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true })
  .flatMap((entry) => (entry.isDirectory() ? sourceFiles(path.join(dir, entry.name)) : [path.join(dir, entry.name)]))
  .filter((file) => /\.(vue|ts)$/.test(file));

test('every icon name written literally in the renderer is defined', () => {
  // vue-tsc checks typed names; this also catches names in untyped data.
  // Only a static <AppIcon name="..."> counts, not :name bindings or other components.
  const patterns = [/<AppIcon\b[^>]*?\sname="([^"]+)"/g, /\bicon(?:Name)?: '([^']+)'/g];
  const names = new Set<string>();
  for (const file of sourceFiles(SOURCE)) {
    const source = fs.readFileSync(file, 'utf8');
    for (const pattern of patterns) for (const match of source.matchAll(pattern)) names.add(match[1]);
  }
  assert.ok(names.size > 20, `expected many icon references, found ${names.size}`);
  for (const name of names) assert.ok(definitions[name], `unknown icon "${name}"`);
});

test('every work package icon is defined', () => {
  for (const task of listTasks()) assert.ok(definitions[task.icon], `${task.id} uses unknown icon "${task.icon}"`);
});

test('AppIcon renders an accessible-hidden SVG with stroke defaults', () => {
  const wrapper = mount(AppIcon, { props: { name: 'check' }, attrs: { class: 'extra' } });
  const svg = wrapper.find('svg');
  assert.equal(svg.attributes('viewBox'), '0 0 24 24');
  assert.equal(svg.attributes('aria-hidden'), 'true');
  assert.equal(svg.attributes('class'), 'icon extra');
  assert.equal(svg.attributes('stroke'), 'currentColor');
  assert.equal(svg.attributes('fill'), 'none');
  assert.equal(svg.element.children.length, ICONS.check.shapes.length);
  assert.equal(svg.element.children[0].namespaceURI, 'http://www.w3.org/2000/svg');
});

test('AppIcon fills instead of strokes for filled icons', () => {
  const svg = mount(AppIcon, { props: { name: 'play' } }).find('svg');
  assert.equal(svg.attributes('fill'), 'currentColor');
  assert.equal(svg.attributes('stroke'), 'none');
  assert.equal(svg.attributes('stroke-width'), undefined);
});

test('AppIcon renders an empty box for an unknown name instead of throwing', () => {
  const svg = mount(AppIcon, { props: { name: 'no-such-icon' as IconName } }).find('svg');
  assert.equal(svg.element.children.length, 0);
  assert.equal(svg.attributes('class'), 'icon');
});

test('icon geometry uses only plain SVG shapes and attributes', () => {
  // Shapes are bound as attributes; keep them free of anything that could
  // carry script or external references.
  const allowedTags = new Set(['path', 'circle', 'rect', 'line', 'polyline']);
  const allowedAttributes = /^(d|cx|cy|r|x|y|width|height|rx|x1|y1|x2|y2|points)$/;
  for (const [name, definition] of Object.entries(definitions)) {
    for (const [tag, attributes] of definition.shapes) {
      assert.ok(allowedTags.has(tag), `${name} uses <${tag}>`);
      for (const key of Object.keys(attributes)) assert.match(key, allowedAttributes, `${name} uses attribute ${key}`);
    }
  }
});
