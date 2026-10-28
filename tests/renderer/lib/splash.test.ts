// @vitest-environment happy-dom
// The splash screen in index.html: loading, failure with retry, and leaving.
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import * as splash from '@/lib/splash.ts';

const html = fs.readFileSync(path.join(import.meta.dirname, '..', '..', '..', 'src', 'renderer', 'index.html'), 'utf8');

beforeEach(() => {
  // The markup the page ships with, scripts aside.
  const page = new DOMParser().parseFromString(html, 'text/html');
  for (const script of page.querySelectorAll('script')) script.remove();
  document.body.replaceChildren(...[...page.body.childNodes].map((node) => document.importNode(node, true)));
});

afterEach(() => vi.useRealTimers());

const root = () => document.getElementById('splash');
const message = () => root()!.querySelector('.splash-message')!;
const retry = () => root()!.querySelector<HTMLButtonElement>('.splash-retry')!;

test('the page starts on the splash, busy and before the app mount point', () => {
  expect(root()?.getAttribute('aria-busy')).toBe('true');
  expect(message().textContent).toBe('正在启动…');
  expect(root()!.compareDocumentPosition(document.getElementById('app')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test('a failure shows the message as an alert and focuses retry, which goes back to loading', () => {
  const clicked = vi.fn();
  splash.onSplashRetry(clicked);
  splash.showSplashError('磁盘已满');
  expect(root()!.classList).toContain('failed');
  expect(root()!.getAttribute('aria-busy')).toBe('false');
  expect(message().textContent).toBe('启动失败：磁盘已满');
  expect(message().getAttribute('role')).toBe('alert');
  expect(document.activeElement).toBe(retry());

  retry().click();
  expect(clicked).toHaveBeenCalledOnce();
  splash.showSplashLoading();
  expect(root()!.classList).not.toContain('failed');
  expect(message().textContent).toBe('正在启动…');
  expect(message().hasAttribute('role')).toBe(false);
});

test('hiding fades the splash out, then removes it', () => {
  vi.useFakeTimers();
  splash.hideSplash();
  expect(root()!.classList).toContain('leaving');
  vi.runAllTimers();
  expect(root()).toBeNull();
  // Calls after it is gone do nothing.
  splash.hideSplash();
  splash.showSplashError('x');
});
