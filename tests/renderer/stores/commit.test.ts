// @vitest-environment happy-dom
import { beforeEach, expect, test, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { CommitPreview } from '@shared/ipc/commit.ts';
import type { IpcResult } from '@shared/ipc/envelope.ts';

import { useCommitStore } from '../../../src/renderer/src/stores/commit.ts';
import { installFakeApi, ok } from '../ipc_fakes.ts';

vi.mock('../../../src/renderer/src/lib/feedback.ts', () => ({ showToast: vi.fn() }));

beforeEach(() => setActivePinia(createPinia()));

test('commit sends arguments IPC can clone, not the reactive preview', async () => {
  const api = installFakeApi({
    commit: {
      preview: () => ok({ files: ['src/command.rs', 'src/workers.rs'], optional: [], skipped: [], message: '进程与线程' }),
      // Electron's IPC uses structured clone, which throws on Vue's proxies.
      create: (id, message, files) => ok({ commit: structuredClone({ id, message, files }) && 'abc12345', files: structuredClone(files) }),
    },
  });
  const store = useCommitStore();
  await store.open('t1');
  await store.commit();
  expect(api.commit.create).toHaveBeenCalledWith('t1', '进程与线程', ['src/command.rs', 'src/workers.rs'], []);
  expect(store.committed?.commit).toBe('abc12345');
});

test('an offered taskpilot.toml is ticked by default, counted, and can be left out', async () => {
  const api = installFakeApi({
    commit: {
      preview: () => ok({ files: ['App.tsx'], optional: ['taskpilot.toml'], skipped: [], message: '骨架' }),
      create: (_id, _message, files, extra = []) => ok({ commit: 'abc12345', files: [...files, ...extra] }),
    },
  });
  const store = useCommitStore();
  await store.open('t1');
  expect(store.extra).toEqual(['taskpilot.toml']);
  expect(store.fileCount).toBe(2);
  store.extra = [];
  expect(store.fileCount).toBe(1);
  await store.commit();
  expect(api.commit.create).toHaveBeenCalledWith('t1', '骨架', ['App.tsx'], []);
});

test('refreshing after a commit discovers a companion lockfile and counts it even if unticked', async () => {
  const api = installFakeApi({
    commit: {
      preview: () => ok({ files: ['App.tsx'], optional: [], skipped: [], message: '骨架' }),
      create: (_id, _message, files, extra = []) => ok({ commit: 'abc12345', files: [...files, ...extra] }),
    },
  });
  const store = useCommitStore();
  await store.open('t1');
  await store.commit();
  expect(store.unsavedFiles('t1')).toBe(0);
  api.commit.preview.mockReturnValue(ok({ files: [], optional: ['package-lock.json'], skipped: [], message: '骨架' }));
  await store.load();
  expect(store.committed).toBeNull();
  expect(store.unsavedFiles('t1')).toBe(1);
  expect(store.fileCount).toBe(1);
  store.extra = [];
  expect(store.fileCount).toBe(0);
  expect(store.canCommit).toBe(false);
  expect(store.unsavedFiles('t1')).toBe(1);
  store.extra = ['package-lock.json'];
  await store.commit();
  expect(api.commit.create).toHaveBeenLastCalledWith('t1', '骨架', [], ['package-lock.json']);
});

test('a delayed preview cannot replace a newer recheck with an empty file list', async () => {
  const api = installFakeApi({ commit: { preview: () => ok({ files: [], optional: [], skipped: [], message: '骨架' }) } });
  const store = useCommitStore();
  await store.open('t1');
  const held = Promise.withResolvers<IpcResult<CommitPreview>>();
  api.commit.preview.mockReturnValueOnce(held.promise);
  const earlier = store.load();
  api.commit.preview.mockReturnValueOnce(ok({ files: [], optional: ['package-lock.json'], skipped: [], message: '锁文件' }));
  await store.load();
  held.resolve({ ok: true, data: { files: [], optional: [], skipped: [], message: '旧结果' } });
  await earlier;
  expect(store.preview?.optional).toEqual(['package-lock.json']);
  expect(store.message).toBe('锁文件');
  expect(store.canCommit).toBe(true);
});
