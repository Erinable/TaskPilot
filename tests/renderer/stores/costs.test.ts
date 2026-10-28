// @vitest-environment happy-dom
// The cost page store: a range change drops an older range's late answer,
// and syncing prices reloads the report once, never twice at a time.
import { beforeEach, expect, test, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises } from '@vue/test-utils';

import * as feedback from '@/lib/feedback.ts';
import { useCostsStore } from '@/stores/costs.ts';
import { fail, installFakeApi, ok } from '../ipc_fakes.ts';
import type * as activityTypes from '@shared/ipc/activity.ts';
import type { IpcResult } from '@shared/ipc/envelope.ts';

vi.mock('@/lib/feedback.ts', () => ({ showToast: vi.fn(), announceAgent: vi.fn(), confirmAction: vi.fn(), openDialogs: { value: 0 } }));

const report = (days: activityTypes.CostRange) => ({ days }) as activityTypes.CostReport;

let api: ReturnType<typeof installFakeApi>;

beforeEach(() => {
  vi.clearAllMocks();
  setActivePinia(createPinia());
  api = installFakeApi({ costs: { report: (days) => ok(report(days)), syncPrices: () => ok({ syncedAt: '2026-10-28T00:00:00Z' }) } });
});

test('a range picked while another loads keeps the newer report and its loading state', async () => {
  const held = Promise.withResolvers<IpcResult<activityTypes.CostReport>>();
  api.costs.report.mockReturnValueOnce(held.promise);
  const store = useCostsStore();
  const first = store.load();
  store.setDays(30);
  await flushPromises();
  expect(store.report?.days).toBe(30);
  expect(store.loading).toBe(false);

  held.resolve({ ok: true, data: report(7) });
  await first;
  expect(store.report?.days).toBe(30);
  expect(store.loading).toBe(false);
});

test('an older load finishing while a newer one runs leaves it loading', async () => {
  const older = Promise.withResolvers<IpcResult<activityTypes.CostReport>>();
  const newer = Promise.withResolvers<IpcResult<activityTypes.CostReport>>();
  api.costs.report.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
  const store = useCostsStore();
  const first = store.load();
  const second = store.load();
  older.resolve({ ok: true, data: report(7) });
  await first;
  expect(store.loading).toBe(true);
  expect(store.report).toBeNull();
  newer.resolve({ ok: true, data: report(7) });
  await second;
  expect(store.loading).toBe(false);
});

test('a stale failure does not replace the current report with an error', async () => {
  const held = Promise.withResolvers<IpcResult<activityTypes.CostReport>>();
  api.costs.report.mockReturnValueOnce(held.promise);
  const store = useCostsStore();
  const first = store.load();
  await store.load();
  held.resolve({ ok: false, error: { code: 'unknown', message: 'late' } });
  await first;
  expect(store.error).toBeNull();
  expect(store.report?.days).toBe(7);
});

test('syncing prices reloads the report, and a second click while syncing does nothing', async () => {
  const store = useCostsStore();
  const syncing = store.syncPrices();
  await store.syncPrices();
  await syncing;
  expect(api.costs.syncPrices).toHaveBeenCalledTimes(1);
  expect(api.costs.report).toHaveBeenCalledTimes(1);
  expect(feedback.showToast).toHaveBeenCalledWith('价格已同步，估算已更新。');
  expect(store.syncing).toBe(false);
});

test('a failed sync keeps the report and shows why', async () => {
  // model_prices.ts throws prices_unavailable, which the IPC boundary sends as unknown.
  api.costs.syncPrices.mockReturnValueOnce(fail('unknown', 'models.dev answered 503'));
  const store = useCostsStore();
  await store.syncPrices();
  expect(store.syncError).toBe('models.dev answered 503');
  expect(api.costs.report).not.toHaveBeenCalled();
  expect(store.syncing).toBe(false);
});
