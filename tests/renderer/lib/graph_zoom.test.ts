import { expect, test } from 'vitest';

import { MAX_SCALE, MIN_SCALE, clampPan, fitView, zoomAt } from '../../../src/renderer/src/lib/graph_zoom.ts';

test('zooming keeps the point under the pointer in place', () => {
  const before = { scale: 1, x: 10, y: 20 };
  const after = zoomAt(before, 2, 110, 70);
  expect(after.scale).toBe(2);
  // The drawing point under (110, 70) was (100, 50); it stays under the pointer.
  expect((110 - after.x) / after.scale).toBe(100);
  expect((70 - after.y) / after.scale).toBe(50);
});

test('zoom stays within its limits', () => {
  expect(zoomAt({ scale: 1, x: 0, y: 0 }, 1000, 0, 0).scale).toBe(MAX_SCALE);
  expect(zoomAt({ scale: 1, x: 0, y: 0 }, 0.0001, 0, 0).scale).toBe(MIN_SCALE);
});

test('a wide graph fits by shrinking and is centred; a small one stays 1:1', () => {
  const wide = fitView({ width: 2700, height: 400 }, { width: 1100, height: 460 });
  expect(wide.scale).toBeCloseTo((1100 - 32) / 2700);
  expect(wide.x).toBeCloseTo((1100 - 2700 * wide.scale) / 2);
  expect(wide.y).toBeCloseTo((460 - 400 * wide.scale) / 2);

  const small = fitView({ width: 300, height: 100 }, { width: 1100, height: 460 });
  expect(small).toEqual({ scale: 1, x: 400, y: 180 });
});

test('a pan never pushes the drawing fully out of the viewport', () => {
  const content = { width: 1000, height: 400 };
  const viewport = { width: 800, height: 400 };
  expect(clampPan({ scale: 1, x: -5000, y: 0 }, content, viewport).x).toBe(48 - 1000);
  expect(clampPan({ scale: 1, x: 5000, y: 0 }, content, viewport).x).toBe(800 - 48);
  expect(clampPan({ scale: 1, x: 0, y: -5000 }, content, viewport).y).toBe(48 - 400);
  expect(clampPan({ scale: 1, x: -100, y: 10 }, content, viewport)).toEqual({ scale: 1, x: -100, y: 10 });
});
