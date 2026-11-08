// @vitest-environment happy-dom
import { beforeEach, expect, test, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises } from '@vue/test-utils';

import { useCodingActivityStore } from '../../../src/renderer/src/stores/coding_activity.ts';
import { useExecutionStore } from '../../../src/renderer/src/stores/execution.ts';
import * as feedback from '../../../src/renderer/src/lib/feedback.ts';
import type * as packageTypes from '../../../src/shared/ipc/packages.ts';
import { codingRun, installApi, taskView } from '../execution_fakes.ts';

vi.mock('../../../src/renderer/src/lib/feedback.ts', () => ({
  showToast: vi.fn(),
  confirmAction: vi.fn(async () => true),
  announceAgent: vi.fn(),
  openDialogs: { value: 0 },
}));

let current: { task: packageTypes.TaskView };
let api: ReturnType<typeof installApi>;
beforeEach(() => {
  setActivePinia(createPinia());
  current = { task: taskView({ status: 'in_progress', codingRun: codingRun({ status: 'running', startedAt: '2026-10-15T00:00:00.000Z' }) }) };
  api = installApi(current);
  api.coding.active.mockReturnValue(Promise.resolve({ ok: true, data: [{ packageId: 't1', title: current.task.title }] }) as never);
  vi.mocked(feedback.announceAgent).mockClear();
});

test('a running package shows in the tracker; when it stops the developer is told once', async () => {
  const store = useCodingActivityStore();
  await store.refresh();
  expect(store.runs).toEqual([{ packageId: 't1', title: current.task.title, label: '第 1 轮编码中', since: '2026-10-15T00:00:00.000Z' }]);
  expect(feedback.announceAgent).not.toHaveBeenCalled();

  // The round finished: nothing runs in the main process any more.
  current.task = { ...current.task, codingRun: codingRun() };
  api.coding.active.mockReturnValue(Promise.resolve({ ok: true, data: [] }) as never);
  await store.refresh();
  expect(store.runs).toEqual([]);
  expect(feedback.announceAgent).toHaveBeenCalledTimes(1);
  expect(vi.mocked(feedback.announceAgent).mock.calls[0][0]).toContain('写好了');

  await store.refresh();
  expect(feedback.announceAgent).toHaveBeenCalledTimes(1);
});

test('a package already waiting when the app opens is not announced', async () => {
  current.task = { ...current.task, codingRun: codingRun() };
  api.coding.active.mockReturnValue(Promise.resolve({ ok: true, data: [] }) as never);
  const store = useCodingActivityStore();
  await store.refresh();
  expect(feedback.announceAgent).not.toHaveBeenCalled();
});

test('QA results for the open package are left to the execution page', async () => {
  current.task = { ...current.task, status: 'in_review', codingRun: codingRun({ status: 'submitted' }) };
  const store = useCodingActivityStore();
  await store.refresh();
  expect(store.runs[0].label).toBe('QA 审查中');
  useExecutionStore().current = current.task;
  current.task = { ...current.task, status: 'accepting' };
  api.coding.active.mockReturnValue(Promise.resolve({ ok: true, data: [] }) as never);
  await store.refresh();
  expect(feedback.announceAgent).not.toHaveBeenCalled();
});

test('coding-only events re-read only packages that join or leave the active list', async () => {
  const store = useCodingActivityStore();
  store.start();
  await flushPromises();
  expect(api.coding.get).toHaveBeenCalledTimes(1);
  api.coding.get.mockClear();

  // Transcript events: the run is still active, so its phase stands.
  api.emitState({ repositoryId: null, domains: ['coding'] });
  api.emitState({ repositoryId: null, domains: ['coding', 'activity'] });
  await flushPromises();
  expect(api.coding.active).toHaveBeenCalledTimes(3);
  expect(api.coding.get).not.toHaveBeenCalled();
  expect(store.runs).toHaveLength(1);

  // A package write can change the phase: every tracked package is read.
  current.task = { ...current.task, codingRun: codingRun({ status: 'checking', startedAt: '2026-10-15T00:00:00.000Z' }) };
  api.emitState({ repositoryId: null, domains: ['packages'] });
  await flushPromises();
  expect(api.coding.get).toHaveBeenCalledTimes(1);
  expect(store.runs[0].label).toBe('第 1 轮编码中');

  // The run left the active list: it is read once and announced.
  current.task = { ...current.task, codingRun: codingRun() };
  api.coding.active.mockReturnValue(Promise.resolve({ ok: true, data: [] }) as never);
  api.emitState({ repositoryId: null, domains: ['coding'] });
  await flushPromises();
  expect(api.coding.get).toHaveBeenCalledTimes(2);
  expect(store.runs).toEqual([]);
  expect(feedback.announceAgent).toHaveBeenCalledTimes(1);
  store.stop();
});
