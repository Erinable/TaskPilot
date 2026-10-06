// Renderer tests that replace window.taskpilot keep the preload's fixed
// fields, so code reading the business time zone sees a real IANA name.
import { beforeEach } from 'vitest';

const BUSINESS_TIME_ZONE = 'Asia/Shanghai';

beforeEach(() => {
  if (typeof window === 'undefined') return;
  let api: Record<string, unknown> = {};
  Object.defineProperty(window, 'taskpilot', {
    configurable: true,
    get: () => api,
    set: (next: Record<string, unknown>) => { api = { businessTimeZone: BUSINESS_TIME_ZONE, ...next }; },
  });
  (window as unknown as { taskpilot: Record<string, unknown> }).taskpilot = {};
});
