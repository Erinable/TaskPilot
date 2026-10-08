// @vitest-environment happy-dom
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

import { useCodingStore } from '../../../src/renderer/src/stores/coding.ts';
import { useExecutionStore } from '../../../src/renderer/src/stores/execution.ts';
import * as feedback from '../../../src/renderer/src/lib/feedback.ts';
import type * as ipc from '../../../src/shared/ipc_types.ts';
import { installApi, taskView } from '../execution_fakes.ts';

vi.mock('../../../src/renderer/src/lib/feedback.ts', () => ({
  showToast: vi.fn(),
  confirmAction: vi.fn(async () => true),
  announceAgent: vi.fn(),
  openDialogs: { value: 0 },
}));

const readyRun = (status: ipc.CodingRun['status']): ipc.CodingRun => ({
  id: 'run-1',
  packageId: 't1',
  runName: 'run',
  baseline: 'abcdef',
  status,
  user: 'coding-agent',
  model: 'test',
  cli: 'codex',
  thinking: 'default',
  runtimeVersion: '1',
  sessionId: null,
  instruction: '实现登录',
  startedAt: '',
  finishedAt: null,
  error: null,
  output: '',
  usage: { inputTokens: null, outputTokens: null, cachedInputTokens: null, reasoningTokens: null, costUsd: null },
  files: [],
  blocked: [],
  checks: {},
  patchDigest: status === 'ready' ? 'digest' : null,
});

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

  test('failed apply retains the patch and reports an error', async () => {
    current.task = taskView({ codingRun: readyRun('ready') });
    const execution = useExecutionStore();
    execution.current = current.task;
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
