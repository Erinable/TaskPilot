// @vitest-environment happy-dom
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

import { useCodingStore } from '../../../src/renderer/src/stores/coding.ts';
import { useExecutionStore } from '../../../src/renderer/src/stores/execution.ts';
import * as feedback from '../../../src/renderer/src/lib/feedback.ts';
import type * as ipc from '../../../src/shared/ipc_types.ts';
import { codingRun, installApi, taskView } from '../execution_fakes.ts';

vi.mock('../../../src/renderer/src/lib/feedback.ts', () => ({
  showToast: vi.fn(),
  confirmAction: vi.fn(async () => true),
  announceAgent: vi.fn(),
  openDialogs: { value: 0 },
}));

const readyRun = (status: ipc.CodingRun['status']) => codingRun({ status });

const file = (path: string, highRisk = false): ipc.CodingPatchFile => ({ path, added: 1, removed: 0, binary: false, highRisk });
const twoFilePatch: ipc.CodingPatchPreview = {
  digest: 'test-digest',
  files: [file('src/a.ts'), file('package.json', true), file('.env')],
  patch: '',
  blocked: [
    { path: 'package.json', reason: 'high-risk project control or test path' },
    { path: '.env', reason: 'secret path' },
  ],
};

let current: { task: ipc.TaskView };
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

  const conflictPatch: ipc.CodingPatchPreview = {
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
    const deferred = Promise.withResolvers<{ ok: true; data: ipc.TaskView }>();
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
});
