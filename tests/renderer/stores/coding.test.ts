// @vitest-environment happy-dom
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises } from '@vue/test-utils';

import { useCodingStore } from '../../../src/renderer/src/stores/coding.ts';
import { useExecutionStore } from '../../../src/renderer/src/stores/execution.ts';
import * as feedback from '../../../src/renderer/src/lib/feedback.ts';
import type * as codingTypes from '../../../src/shared/coding_types.ts';
import type * as packageTypes from '../../../src/shared/ipc/packages.ts';
import { codingRun, installApi, taskView } from '../execution_fakes.ts';

vi.mock('../../../src/renderer/src/lib/feedback.ts', () => ({
  showToast: vi.fn(),
  confirmAction: vi.fn(async () => true),
  announceAgent: vi.fn(),
  openDialogs: { value: 0 },
}));

const readyRun = (status: codingTypes.CodingRun['status']) => codingRun({ status });

const file = (path: string, highRisk = false): codingTypes.CodingPatchFile => ({ path, added: 1, removed: 0, binary: false, highRisk });
const twoFilePatch: codingTypes.CodingPatchPreview = {
  digest: 'test-digest',
  files: [file('src/a.ts'), file('package.json', true), file('.env')],
  patch: '',
  blocked: [
    { path: 'package.json', reason: 'high-risk project control or test path' },
    { path: '.env', reason: 'secret path' },
  ],
};

let current: { task: packageTypes.TaskView };
let api: ReturnType<typeof installApi>;

beforeEach(() => {
  setActivePinia(createPinia());
  current = { task: taskView() };
  api = installApi(current);
  vi.mocked(feedback.confirmAction).mockResolvedValue(true);
});

describe('coding store', () => {
  test('starts from an explicit instruction and sends no resume option', async () => {
    const execution = useExecutionStore();
    execution.current = current.task;
    const coding = useCodingStore();
    await coding.select('t1');
    coding.instruction = '修复登录';
    await coding.start();
    expect(api.coding.start).toHaveBeenCalledWith('t1', { instruction: '修复登录' });
  });

  test('cancel refreshes the task and clears a pending result', async () => {
    current.task = taskView({ codingRun: readyRun('ready') });
    const execution = useExecutionStore();
    execution.current = current.task;
    const coding = useCodingStore();
    await coding.select('t1');
    expect(coding.patch).not.toBe(null);
    await coding.cancel();
    expect(api.coding.cancel).toHaveBeenCalledWith('t1');
    expect(coding.patch).toBe(null);
  });

  test('keeps a ready patch when discard confirmation is declined', async () => {
    current.task = taskView({ codingRun: readyRun('ready') });
    const execution = useExecutionStore();
    execution.current = current.task;
    const coding = useCodingStore();
    await coding.select('t1');
    vi.mocked(feedback.confirmAction).mockResolvedValueOnce(false);
    expect(await coding.cancel()).toBe(false);
    expect(coding.patch).not.toBe(null);
    expect(api.coding.cancel).not.toHaveBeenCalled();
  });

  test('applies only the ticked files; high-risk and blocked files start unticked', async () => {
    current.task = taskView({ codingRun: readyRun('ready') });
    const execution = useExecutionStore();
    execution.current = current.task;
    api.coding.patch.mockResolvedValueOnce({ ok: true, data: twoFilePatch });
    const coding = useCodingStore();
    await coding.select('t1');
    expect(coding.selectedFiles).toEqual(['src/a.ts']);
    expect(coding.applicable(twoFilePatch.files[2])).toBe(false);
    coding.toggleFile('src/a.ts', false);
    expect(await coding.apply(false)).toBe(false);
    coding.toggleFile('package.json', true);
    expect(coding.highRisk).toBe(true);
    expect(await coding.apply(false)).toBe(false);
    expect(await coding.apply(true)).toBe(true);
    expect(api.coding.apply).toHaveBeenCalledWith('t1', { digest: 'test-digest', allowHighRisk: true, files: ['package.json'], resolutions: {} });
  });

  const conflictPatch: codingTypes.CodingPatchPreview = {
    digest: 'patch-digest',
    mergeDigest: 'merge-digest',
    files: [file('src/a.ts'), file('src/b.ts')],
    patch: '',
    blocked: [],
    merge: [
      { path: 'src/a.ts', state: 'conflict', markers: true },
      { path: 'src/b.ts', state: 'merged', markers: false },
    ],
  };

  test('a selected conflict needs a choice, and the merge digest is what gets confirmed', async () => {
    current.task = taskView({ codingRun: readyRun('ready') });
    useExecutionStore().current = current.task;
    api.coding.patch.mockResolvedValueOnce({ ok: true, data: conflictPatch });
    const coding = useCodingStore();
    await coding.select('t1');
    expect(coding.unresolved).toEqual(['src/a.ts']);
    expect(await coding.apply(false)).toBe(false);
    expect(api.coding.apply).not.toHaveBeenCalled();
    coding.setResolution('src/a.ts', 'markers');
    expect(coding.unresolved).toEqual([]);
    expect(await coding.apply(false)).toBe(true);
    expect(api.coding.apply).toHaveBeenCalledWith('t1', {
      digest: 'merge-digest',
      allowHighRisk: false,
      files: ['src/a.ts', 'src/b.ts'],
      resolutions: { 'src/a.ts': 'markers' },
    });
    // An unticked conflict needs no choice.
    coding.toggleFile('src/a.ts', false);
    expect(coding.unresolved).toEqual([]);
  });

  test('taking the agent version over my edits asks on its own, and declining sends nothing', async () => {
    current.task = taskView({ codingRun: readyRun('ready') });
    useExecutionStore().current = current.task;
    api.coding.patch.mockResolvedValueOnce({ ok: true, data: conflictPatch });
    const coding = useCodingStore();
    await coding.select('t1');
    coding.setResolution('src/a.ts', 'theirs');
    vi.mocked(feedback.confirmAction).mockResolvedValueOnce(false);
    expect(await coding.apply(false)).toBe(false);
    expect(api.coding.apply).not.toHaveBeenCalled();
    expect(vi.mocked(feedback.confirmAction).mock.calls.at(-1)?.[0]).toMatchObject({ title: '用 AI 的版本覆盖 1 个文件？', danger: true });
  });

  test('resume asks the main process to go on after the markers are cleared', async () => {
    current.task = taskView({ codingRun: { ...readyRun('applied'), halt: 'markers' } });
    useExecutionStore().current = current.task;
    const coding = useCodingStore();
    await coding.select('t1');
    expect(await coding.resume()).toBe(true);
    expect(api.coding.resume).toHaveBeenCalledWith('t1');
  });

  test('failed apply retains the patch and reports an error', async () => {
    current.task = taskView({ codingRun: readyRun('ready') });
    const execution = useExecutionStore();
    execution.current = current.task;
    api.coding.patch.mockResolvedValueOnce({ ok: true, data: twoFilePatch });
    const coding = useCodingStore();
    await coding.select('t1');
    api.coding.apply.mockResolvedValueOnce({ ok: false, error: { code: 'apply_failed', message: '拒绝写入' } } as never);
    await coding.apply(false);
    expect(coding.patch).not.toBe(null);
    expect(coding.error).toContain('应用编码改动失败');
  });

  test('ignores stale get results after switching task', async () => {
    const execution = useExecutionStore();
    execution.current = current.task;
    const coding = useCodingStore();
    const deferred = Promise.withResolvers<{ ok: true; data: packageTypes.TaskView }>();
    let markGetStarted: (() => void) | null = null;
    const getStarted = new Promise<void>((resolve) => {
      markGetStarted = resolve;
    });
    api.coding.get.mockImplementationOnce(() => {
      markGetStarted?.();
      return deferred.promise;
    });
    const first = coding.select('t1');
    await getStarted;
    const secondTask = taskView({ id: 't2', title: '第二个任务' });
    execution.current = secondTask;
    api.coding.get.mockResolvedValueOnce({ ok: true, data: secondTask });
    await coding.select('t2');
    deferred.resolve({ ok: true, data: current.task });
    await first;
    expect(execution.current?.id).toBe('t2');
  });

  test('a transcript event reads only new events; a packages change also reads the package', async () => {
    current.task = taskView({ codingRun: codingRun({ status: 'running' }) });
    const execution = useExecutionStore();
    execution.current = current.task;
    const coding = useCodingStore();
    await coding.select('t1');
    await flushPromises();
    api.coding.get.mockClear();
    api.coding.events.mockClear();

    api.coding.events.mockResolvedValueOnce({
      ok: true,
      data: { events: [{ sequence: 0, type: 'text', text: '读取文件', at: '' }], next: 0, truncated: false },
    });
    api.emitState({ repositoryId: null, domains: ['coding', 'activity'] });
    await flushPromises();
    expect(api.coding.events).toHaveBeenCalledTimes(1);
    expect(api.coding.get).not.toHaveBeenCalled();
    expect(coding.events).toHaveLength(1);

    current.task = taskView({ codingRun: codingRun({ status: 'checking' }) });
    api.emitState({ repositoryId: null, domains: ['packages'] });
    await flushPromises();
    expect(api.coding.events).toHaveBeenCalledTimes(2);
    expect(api.coding.events).toHaveBeenLastCalledWith('t1', 0);
    expect(api.coding.get).toHaveBeenCalledTimes(1);
    expect(execution.current?.codingRun?.status).toBe('checking');
    coding.leave();
  });
});

test('an automatic ready round is not fetched until it stops for human review', async () => {
  current.task = taskView({ codingRun: codingRun({ status: 'ready', trigger: 'checks_failed', attempt: 2, halt: null }) });
  useExecutionStore().current = current.task;
  const coding = useCodingStore();
  await coding.select('t1');
  await flushPromises();
  expect(api.coding.patch).not.toHaveBeenCalled();
  current.task = taskView({ codingRun: { ...current.task.codingRun!, halt: 'high_risk' } });
  api.emitState({ repositoryId: null, domains: ['packages'] });
  await flushPromises();
  expect(api.coding.patch).toHaveBeenCalledTimes(1);
  expect(coding.patch).not.toBeNull();
  coding.leave();
});

test('select and package refresh share one pending patch request for the same round', async () => {
  current.task = taskView({ codingRun: readyRun('ready') });
  useExecutionStore().current = current.task;
  const held = Promise.withResolvers<{ ok: true; data: codingTypes.CodingPatchPreview }>();
  const entered = Promise.withResolvers<void>();
  api.coding.patch.mockImplementation(() => {
    entered.resolve();
    return held.promise;
  });
  const coding = useCodingStore();
  const selecting = coding.select('t1');
  await entered.promise;
  await flushPromises();
  expect(api.coding.patch).toHaveBeenCalledTimes(1);
  held.resolve({ ok: true, data: twoFilePatch });
  await selecting;
  await flushPromises();
  expect(coding.patchLoading).toBe(false);
  coding.leave();
});

test('a patch read that lost a race to discard refreshes the lifecycle without showing a workspace failure', async () => {
  current.task = taskView({ codingRun: readyRun('ready') });
  useExecutionStore().current = current.task;
  const held = Promise.withResolvers<{ ok: false; error: { code: 'workspace_process_failed'; message: string } }>();
  const entered = Promise.withResolvers<void>();
  api.coding.patch.mockImplementation(() => {
    entered.resolve();
    return held.promise;
  });
  const coding = useCodingStore();
  const selecting = coding.select('t1');
  await entered.promise;
  current.task = taskView({ codingRun: { ...current.task.codingRun!, status: 'discarded', halt: 'no_changes' } });
  held.resolve({ ok: false, error: { code: 'workspace_process_failed', message: 'run directory was cleaned' } });
  await selecting;
  await flushPromises();
  expect(coding.run?.status).toBe('discarded');
  expect(coding.error).toBeNull();
  expect(coding.patch).toBeNull();
  expect(coding.patchLoading).toBe(false);
  coding.leave();
});

test('late patch output from an older round cannot populate the next round of the same package', async () => {
  current.task = taskView({ codingRun: readyRun('ready') });
  const execution = useExecutionStore();
  execution.current = current.task;
  const held = Promise.withResolvers<{ ok: true; data: codingTypes.CodingPatchPreview }>();
  const entered = Promise.withResolvers<void>();
  api.coding.patch.mockImplementation(() => {
    entered.resolve();
    return held.promise;
  });
  const coding = useCodingStore();
  const selecting = coding.select('t1');
  await entered.promise;
  current.task = taskView({ codingRun: codingRun({ id: 'next-round', status: 'running', attempt: 2 }) });
  execution.adoptTask(current.task);
  held.resolve({ ok: true, data: twoFilePatch });
  await selecting;
  await flushPromises();
  expect(coding.run?.id).toBe('next-round');
  expect(coding.patchLoading).toBe(false);
  expect(coding.patch).toBeNull();
  expect(coding.selectedFiles).toEqual([]);
  expect(coding.error).toBeNull();
  coding.leave();
});

test('a real patch-read failure on the same retained round remains visible', async () => {
  current.task = taskView({ codingRun: readyRun('ready') });
  useExecutionStore().current = current.task;
  api.coding.patch.mockResolvedValue({ ok: false, error: { code: 'workspace_process_failed', message: 'real diff failure' } });
  const coding = useCodingStore();
  await coding.select('t1');
  await flushPromises();
  expect(coding.error).toContain('读取补丁失败');
  expect(coding.run?.status).toBe('ready');
  coding.leave();
});

test('opening a package with no run does not fetch a nonexistent transcript and the first click starts once', async () => {
  useExecutionStore().current = current.task;
  const coding = useCodingStore();
  await coding.select('t1');
  await flushPromises();
  expect(coding.error).toBeNull();
  expect(api.coding.events).not.toHaveBeenCalled();
  expect(coding.canStart).toBe(true);
  api.coding.start.mockImplementation(async () => {
    current.task = taskView({ codingRun: codingRun({ status: 'running' }) });
    return { ok: true, data: current.task };
  });
  expect(await coding.start()).toBe(true);
  await flushPromises();
  expect(api.coding.start).toHaveBeenCalledTimes(1);
  expect(coding.run?.status).toBe('running');
  expect(coding.error).toBeNull();
  expect(api.coding.events).toHaveBeenCalledWith('t1', -1);
  coding.leave();
});

test.each(['null', 'failure'] as const)('an obsolete pre-start %s refresh cannot erase the first started run or show a stale error', async (outcome) => {
  useExecutionStore().current = current.task;
  const oldTask = current.task;
  const held = Promise.withResolvers<Awaited<ReturnType<typeof api.coding.get>>>();
  const entered = Promise.withResolvers<void>();
  api.coding.get.mockResolvedValueOnce({ ok: true, data: oldTask }).mockImplementationOnce(() => {
    entered.resolve();
    return held.promise;
  });
  const coding = useCodingStore();
  await coding.select('t1');
  await entered.promise;
  expect(api.coding.events).not.toHaveBeenCalled();
  api.coding.start.mockImplementation(async () => {
    current.task = taskView({ codingRun: codingRun({ status: 'running' }) });
    return { ok: true, data: current.task };
  });
  expect(await coding.start()).toBe(true);
  held.resolve(outcome === 'null' ? { ok: true, data: oldTask } : { ok: false, error: { code: 'coding_not_running', message: 'No coding run exists' } });
  await flushPromises();
  expect(coding.run?.id).toBe('run-1');
  expect(coding.run?.status).toBe('running');
  expect(coding.error).toBeNull();
  expect(coding.eventsLoading).toBe(false);
  expect(api.coding.start).toHaveBeenCalledTimes(1);
  coding.leave();
});

test('package changes discover a newly started run before reading its transcript, with the cursor reset', async () => {
  current.task = taskView({ codingRun: codingRun({ status: 'running', id: 'old' }) });
  useExecutionStore().current = current.task;
  api.coding.events.mockResolvedValue({ ok: true, data: { events: [{ sequence: 0, at: '', type: 'text', text: '旧轮次' }], next: 0, truncated: false } });
  const coding = useCodingStore();
  await coding.select('t1');
  await flushPromises();
  expect(coding.events.map((event) => event.text)).toEqual(['旧轮次']);
  const order: string[] = [];
  current.task = taskView({ codingRun: codingRun({ status: 'running', id: 'new' }) });
  api.coding.get.mockImplementation(async () => {
    order.push('get');
    return { ok: true, data: current.task };
  });
  api.coding.events.mockImplementation(async (_id, after) => {
    order.push(`events:${after}`);
    return { ok: true, data: { events: [{ sequence: 0, at: '', type: 'text', text: '新轮次' }], next: 0, truncated: false } };
  });
  api.emitState({ repositoryId: null, domains: ['packages'] });
  await flushPromises();
  expect(order).toEqual(['get', 'events:-1']);
  expect(coding.events.map((event) => event.text)).toEqual(['新轮次']);
  expect(coding.error).toBeNull();
  coding.leave();
});

test('a released package clears its transcript without requesting events for the removed run', async () => {
  current.task = taskView({ codingRun: codingRun({ status: 'running' }) });
  useExecutionStore().current = current.task;
  const coding = useCodingStore();
  await coding.select('t1');
  await flushPromises();
  api.coding.events.mockClear();
  current.task = taskView({ codingRun: null, status: 'pending' });
  api.emitState({ repositoryId: null, domains: ['packages'] });
  await flushPromises();
  expect(api.coding.events).not.toHaveBeenCalled();
  expect(coding.run).toBeNull();
  expect(coding.events).toEqual([]);
  expect(coding.error).toBeNull();
  coding.leave();
});

test('a real initial start failure remains visible while no-run refresh stays harmless', async () => {
  useExecutionStore().current = current.task;
  const coding = useCodingStore();
  await coding.select('t1');
  await flushPromises();
  api.coding.start.mockResolvedValueOnce({ ok: false, error: { code: 'workspace_process_failed', message: 'snapshot failed' } });
  expect(await coding.start()).toBe(false);
  await flushPromises();
  expect(coding.error).toContain('启动编码失败');
  expect(api.coding.events).not.toHaveBeenCalled();
  const before = api.coding.get.mock.calls.length;
  api.emitState({ repositoryId: null, domains: ['packages'] });
  await flushPromises();
  expect(api.coding.get.mock.calls.length).toBe(before + 1);
  expect(coding.error).toContain('启动编码失败');
  coding.leave();
});

test('the execution and coding watchers load a completed patch even when execution refreshes first', async () => {
  current.task = taskView({ codingRun: codingRun({ status: 'running' }) });
  const execution = useExecutionStore();
  await execution.open('t1');
  const coding = useCodingStore();
  await coding.select('t1');
  await flushPromises();
  const held = Promise.withResolvers<Awaited<ReturnType<typeof api.coding.get>>>();
  const entered = Promise.withResolvers<void>();
  api.coding.get.mockImplementationOnce(() => {
    entered.resolve();
    return held.promise;
  });
  current.task = taskView({ codingRun: codingRun({ status: 'ready' }) });
  api.emitState({ repositoryId: null, domains: ['packages'] });
  await entered.promise;
  await flushPromises();
  expect(execution.current?.codingRun?.status).toBe('ready');
  held.resolve({ ok: true, data: current.task });
  await flushPromises();
  expect(api.coding.patch).toHaveBeenCalledTimes(1);
  expect(coding.patch).not.toBeNull();
  coding.leave();
  execution.close();
});

test.each(['new-round', 'released'] as const)(
  'a newer execution refresh reconciles the transcript for %s without adopting stale lifecycle data',
  async (change) => {
    current.task = taskView({ codingRun: codingRun({ status: 'running', id: 'old' }) });
    const execution = useExecutionStore();
    execution.current = current.task;
    api.coding.events.mockResolvedValueOnce({
      ok: true,
      data: { events: [{ sequence: 9, at: '', type: 'text', text: '旧轮次' }], next: 9, truncated: false },
    });
    const coding = useCodingStore();
    await coding.select('t1');
    await flushPromises();
    expect(coding.events.map((event) => event.text)).toEqual(['旧轮次']);
    const oldTask = current.task;
    const held = Promise.withResolvers<Awaited<ReturnType<typeof api.coding.get>>>();
    api.coding.get.mockReturnValueOnce(held.promise);
    api.coding.events.mockClear();
    api.coding.events.mockImplementation(async (_id, after) => ({
      ok: true,
      data: { events: after < 0 ? [{ sequence: 0, at: '', type: 'text', text: '新轮次' }] : [], next: 0, truncated: false },
    }));
    api.emitState({ repositoryId: null, domains: ['packages'] });
    current.task = change === 'released' ? taskView({ status: 'pending' }) : taskView({ codingRun: codingRun({ status: 'running', id: 'new' }) });
    execution.adoptTask(current.task);
    held.resolve({ ok: true, data: oldTask });
    await flushPromises();
    if (change === 'released') {
      expect(coding.run).toBeNull();
      expect(coding.events).toEqual([]);
      expect(api.coding.events).not.toHaveBeenCalled();
    } else {
      expect(coding.run?.id).toBe('new');
      expect(api.coding.events).toHaveBeenNthCalledWith(1, 't1', -1);
      expect(coding.events.map((event) => event.text)).toEqual(['新轮次']);
    }
    expect(coding.error).toBeNull();
    coding.leave();
  },
);

test('a local task edit during a lifecycle read cannot hide the completed patch', async () => {
  current.task = taskView({ codingRun: codingRun({ status: 'running' }) });
  const execution = useExecutionStore();
  execution.current = current.task;
  const coding = useCodingStore();
  await coding.select('t1');
  await flushPromises();
  const held = Promise.withResolvers<Awaited<ReturnType<typeof api.coding.get>>>();
  api.coding.get.mockReturnValueOnce(held.promise);
  api.emitState({ repositoryId: null, domains: ['packages'] });
  execution.adoptTask({ ...current.task, completedSteps: [0] });
  current.task = taskView({ codingRun: codingRun({ status: 'ready' }), completedSteps: [0] });
  held.resolve({ ok: true, data: current.task });
  await flushPromises();
  expect(coding.run?.status).toBe('ready');
  expect(execution.current?.completedSteps).toEqual([0]);
  expect(coding.patch).not.toBeNull();
  coding.leave();
});

test('starting from acceptance is refused locally, and rejection back to execution restores the coding action', async () => {
  current.task = taskView({ status: 'accepting', mode: 'ai', codingRun: codingRun({ status: 'submitted' }) });
  useExecutionStore().current = current.task;
  const coding = useCodingStore();
  await coding.select('t1');
  expect(coding.canStart).toBe(false);
  expect(await coding.start()).toBe(false);
  expect(api.coding.start).not.toHaveBeenCalled();
  current.task = { ...current.task, status: 'in_progress' };
  useExecutionStore().adoptTask(current.task);
  expect(coding.canStart).toBe(true);
  expect(await coding.start()).toBe(true);
  expect(api.coding.start).toHaveBeenCalledTimes(1);
  coding.leave();
});
