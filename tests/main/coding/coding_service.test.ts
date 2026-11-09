// The Coding Agent loop's change notifications (src/main/coding/coding_service.ts).
import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';

import * as preferences from '../../../src/main/app/preferences.ts';
import { BackgroundRuns } from '../../../src/main/app/background_runs.ts';
import { EVENT_NOTIFY_MS, createCodingService } from '../../../src/main/coding/coding_service.ts';
import { SAMPLE_TASKS } from '../fixtures/sample_tasks.ts';
import type * as codingTypes from '../../../src/shared/coding_types.ts';
import type { StateDomain } from '../../../src/shared/ipc/state.ts';

type ServiceContext = Parameters<typeof createCodingService>[0];
type Runtime = Parameters<typeof createCodingService>[1];

afterEach(() => {
  vi.useRealTimers();
});

const TASK = SAMPLE_TASKS.find((task) => task.id === 'auth-edge-tests')!;
const USAGE = { inputTokens: 1, outputTokens: 1, cachedInputTokens: null, reasoningTokens: null, costUsd: null };

// A coding service over in-memory fakes whose CLI run streams the events the
// test pushes through `emit` and ends when the test calls `finish`.
const codingHarness = () => {
  const notified: StateDomain[][] = [];
  let codingRun: codingTypes.CodingRun | null = null;
  const state = () => ({ status: 'in_progress', baseline: 'base', mode: null, codingRun, baselineChecks: null });
  const claim = Symbol('claim');
  const store = {
    get: () => state(),
    claimIdentity: () => claim,
    setCodingRun: async (_id: string, run: codingTypes.CodingRun) => {
      codingRun = run;
      return state();
    },
    updateCodingRun: async (_id: string, patch: Partial<codingTypes.CodingRun>) => {
      codingRun = { ...(codingRun as codingTypes.CodingRun), ...patch };
      return state();
    },
  };
  const ctx = {
    store,
    backgroundRuns: new BackgroundRuns(),
    getPreferences: preferences.defaults,
    requireTask: () => TASK,
    requireRoot: () => '/repo',
    requireBaseline: () => 'base',
    getConfig: () => ({ root: '/repo' }),
    record: () => {},
    recordCall: () => {},
    changed: (...domains: StateDomain[]) => void notified.push(domains),
    onCancelAll: () => {},
    profile: async () => null,
    packageLabel: () => () => TASK.title,
    viewOf: () => ({}),
  } as unknown as ServiceContext;
  const stream = Promise.withResolvers<void>();
  let onEvent: ((event: codingTypes.CodingEvent) => void) | undefined;
  const runtime = {
    snapshot: async () => 'base',
    startSandbox: async () => undefined,
    runNameFor: (_sandbox: unknown, runId: string) => `/runs/${runId}`,
    prepare: async (_root: string, _baseline: string, options: { runName: string }) => ({ runName: options.runName, directory: options.runName }),
    codingPrompt: () => 'prompt',
    run: async (options: { onEvent?: (event: codingTypes.CodingEvent) => void }) => {
      onEvent = options.onEvent;
      await stream.promise;
      return { output: 'done', usage: USAGE, events: [], sessionId: null };
    },
    readPatch: async () => ({ patch: '', files: [], blocked: [], digest: 'd' }),
    cleanRun: async () => {},
  } as unknown as Runtime;
  const service = createCodingService(ctx, runtime, { startReview: async () => {} });
  const emit = (sequence: number) => onEvent?.({ sequence, at: new Date().toISOString(), type: 'text', text: `event ${sequence}` });
  // Notifications naming the coding domain, the ones a refetch follows.
  const codingNotices = () => notified.filter((domains) => domains.includes('coding') && domains.includes('activity')).length;
  return { service, ctx, emit, finish: () => stream.resolve(), codingNotices, notified, streaming: () => onEvent !== undefined };
};

test('a streaming round notifies at most once per window, trailing, and flushes when it ends', async () => {
  vi.useFakeTimers();
  const h = codingHarness();
  await h.service.start(TASK.id, 'write the tests');
  await vi.advanceTimersByTimeAsync(0);
  assert.equal(h.streaming(), true);
  const before = h.codingNotices();

  for (let sequence = 0; sequence < 50; sequence += 1) h.emit(sequence);
  assert.equal(h.codingNotices(), before, 'nothing is sent while the window is open');
  await vi.advanceTimersByTimeAsync(EVENT_NOTIFY_MS - 1);
  assert.equal(h.codingNotices(), before);
  await vi.advanceTimersByTimeAsync(1);
  assert.equal(h.codingNotices(), before + 1, 'one trailing notification for the burst');

  // A quiet window sends nothing.
  await vi.advanceTimersByTimeAsync(EVENT_NOTIFY_MS * 4);
  assert.equal(h.codingNotices(), before + 1);

  // Events pending when the run ends are sent at once, not a window later.
  h.emit(50);
  h.emit(51);
  h.finish();
  await vi.advanceTimersByTimeAsync(0);
  assert.equal(h.codingNotices(), before + 2);
  await h.ctx.backgroundRuns.idle();
  assert.equal(vi.getTimerCount(), 0, 'no timer outlives the run');
  assert.equal(h.ctx.backgroundRuns.has('coding', TASK.id), false);
});
