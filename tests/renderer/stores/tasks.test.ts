// @vitest-environment happy-dom
import { beforeEach, expect, test } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

import { useTasksStore } from '../../../src/renderer/src/stores/tasks.ts';
import { installApi, taskView } from '../execution_fakes.ts';
import type { IpcResult } from '../../../src/shared/ipc/envelope.ts';
import type { TaskView } from '../../../src/shared/ipc/packages.ts';

beforeEach(() => setActivePinia(createPinia()));

test('a queue response from before repository reset cannot replace the new queue', async () => {
  const api = installApi({ task: taskView() });
  const old = Promise.withResolvers<IpcResult<TaskView[]>>();
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
