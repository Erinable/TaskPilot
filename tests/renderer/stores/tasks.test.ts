// @vitest-environment happy-dom
import { beforeEach, expect, test } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

import { useTasksStore } from '../../../src/renderer/src/stores/tasks.ts';
import { useRepositoryIdentityStore } from '../../../src/renderer/src/stores/repository_identity.ts';
import { installFakeApi, fail, ok } from '../ipc_fakes.ts';
import { taskView } from '../execution_fakes.ts';

beforeEach(() => setActivePinia(createPinia()));

test('a queue response from before repository reset cannot replace the new queue', async () => {
  const api = installFakeApi({ tasks: { list: () => ok([]) } });
  const old = Promise.withResolvers<Awaited<ReturnType<typeof api.tasks.list>>>();
  api.tasks.list.mockReturnValueOnce(old.promise);
  const store = useTasksStore();
  const previousRead = store.reloadQueue();
  store.reset();
  const next = taskView({ id: 'new-repository-task' });
  api.tasks.list.mockResolvedValueOnce({ ok: true, data: [next] });
  await store.reloadQueue();
  old.resolve({ ok: true, data: [taskView({ id: 'old-repository-task' })] });
  await previousRead;
  expect(store.tasks.map((task) => task.id)).toEqual(['new-repository-task']);
});

test('adoptTask replaces one queue entry in place and adds nothing it does not list', () => {
  const store = useTasksStore();
  store.tasks = [taskView(), taskView({ id: 't2' })];
  store.adoptTask(taskView({ status: 'in_review' }));
  store.adoptTask(taskView({ id: 'unlisted' }));
  expect(store.tasks.map((task) => [task.id, task.status])).toEqual([
    ['t1', 'in_review'],
    ['t2', 'in_progress'],
  ]);
});

test('first load failures stay visible and a successful empty retry is a real empty queue', async () => {
  const api = installFakeApi({ tasks: { list: () => fail('unknown', '读取失败') } });
  const store = useTasksStore();
  await expect(store.reloadQueue()).rejects.toThrow('读取失败');
  expect(store.error).toBe('读取失败');
  expect(store.loaded).toBe(false);
  expect(store.loading).toBe(false);
  api.tasks.list.mockImplementation(() => ok([]));
  await store.reloadQueue();
  expect(store.loaded).toBe(true);
  expect(store.error).toBeNull();
  expect(store.tasks).toEqual([]);
});

test('refresh failures retain known packages until retry succeeds', async () => {
  const api = installFakeApi({ tasks: { list: () => ok([taskView({ title: '已知任务' })]) } });
  const store = useTasksStore();
  await store.reloadQueue();
  api.tasks.list.mockImplementationOnce(() => fail('unknown', '磁盘不可读'));
  await expect(store.reloadQueue()).rejects.toThrow();
  expect(store.tasks[0].title).toBe('已知任务');
  expect(store.loaded).toBe(true);
  api.tasks.list.mockImplementation(() => ok([taskView({ title: '更新后的任务' })]));
  await store.reloadQueue();
  expect(store.error).toBeNull();
  expect(store.tasks[0].title).toBe('更新后的任务');
});

test('newer reads win over late results and late failures', async () => {
  const api = installFakeApi({ tasks: { list: () => ok([taskView({ title: '最新任务' })]) } });
  const held = Promise.withResolvers<Awaited<ReturnType<typeof api.tasks.list>>>();
  api.tasks.list.mockReturnValueOnce(held.promise);
  const store = useTasksStore();
  const old = store.reloadQueue();
  expect(store.loading).toBe(true);
  await store.reloadQueue();
  held.resolve({ ok: false, error: { code: 'unknown', message: '过时失败' } });
  await old;
  expect(store.tasks[0].title).toBe('最新任务');
  expect(store.error).toBeNull();
  expect(store.loading).toBe(false);
});

test('a reset and repository change invalidate in flight responses and errors', async () => {
  const api = installFakeApi();
  const held = Promise.withResolvers<Awaited<ReturnType<typeof api.tasks.list>>>();
  api.tasks.list.mockReturnValueOnce(held.promise);
  const store = useTasksStore();
  useRepositoryIdentityStore().currentId = 'a';
  const old = store.reloadQueue();
  store.reset();
  useRepositoryIdentityStore().currentId = 'b';
  held.resolve({ ok: true, data: [taskView({ title: '旧仓库任务' })] });
  await old;
  expect(store.tasks).toEqual([]);
  expect(store.loaded).toBe(false);
  expect(store.loading).toBe(false);
  expect(store.error).toBeNull();
});
