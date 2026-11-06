// @vitest-environment happy-dom
import { beforeEach, expect, test, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

import { useCommitStore } from '../../../src/renderer/src/stores/commit.ts';
import { installFakeApi, ok } from '../ipc_fakes.ts';

vi.mock('../../../src/renderer/src/lib/feedback.ts', () => ({ showToast: vi.fn() }));

beforeEach(() => setActivePinia(createPinia()));

test('commit sends arguments IPC can clone, not the reactive preview', async () => {
  const api = installFakeApi({
    commit: {
      preview: () => ok({ files: ['src/command.rs', 'src/workers.rs'], skipped: [], message: '进程与线程' }),
      // Electron's IPC uses structured clone, which throws on Vue's proxies.
      create: (id, message, files) => ok({ commit: structuredClone({ id, message, files }) && 'abc12345', files: structuredClone(files) }),
    },
  });
  const store = useCommitStore();
  await store.open('t1');
  await store.commit();
  expect(api.commit.create).toHaveBeenCalledWith('t1', '进程与线程', ['src/command.rs', 'src/workers.rs']);
  expect(store.committed?.commit).toBe('abc12345');
});
