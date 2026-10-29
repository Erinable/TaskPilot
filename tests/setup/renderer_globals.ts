// Renderer tests that replace window.taskpilot keep the preload's fixed
// fields, so code reading the business time zone sees a real IANA name.
import { beforeEach } from 'vitest';

const BUSINESS_TIME_ZONE = 'Asia/Shanghai';

// src/renderer/index.html starts with <!doctype html>; happy-dom has no
// compatMode, which KaTeX reads on import to refuse quirks mode.
if (typeof document !== 'undefined' && document.compatMode === undefined) {
  Object.defineProperty(document, 'compatMode', { configurable: true, value: 'CSS1Compat' });
}

// happy-dom's Element.toString() returns outerHTML where browsers return
// "[object HTMLDivElement]". Popper calls it on every node it walks, so each
// Element Plus popper serialized the whole document.
if (typeof Element !== 'undefined') {
  Object.defineProperty(Element.prototype, 'toString', { configurable: true, writable: true, value: Object.prototype.toString });
}

beforeEach(() => {
  if (typeof window === 'undefined') return;
  let api: Record<string, unknown> = {};
  Object.defineProperty(window, 'taskpilot', {
    configurable: true,
    get: () => api,
    set: (next: Record<string, unknown>) => {
      api = { businessTimeZone: BUSINESS_TIME_ZONE, ...next };
    },
  });
  (window as unknown as { taskpilot: Record<string, unknown> }).taskpilot = {};
});
