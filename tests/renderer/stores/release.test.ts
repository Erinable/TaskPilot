// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises } from '@vue/test-utils';

import * as feedback from '../../../src/renderer/src/lib/feedback.ts';
import { useReleaseStore } from '../../../src/renderer/src/stores/release.ts';
import * as fakes from '../release_fakes.ts';
import type * as releaseTypes from '../../../src/shared/ipc/release.ts';

vi.mock('../../../src/renderer/src/lib/feedback.ts', () => {
  const showToast = vi.fn();
  // announceAgent adds a system notification only in the background; tests see the toast.
  return { showToast, announceAgent: (...args: unknown[]) => showToast(...args), confirmAction: vi.fn(async () => true), openDialogs: { value: 0 } };
});

describe('release store', () => {
  let state: { current: releaseTypes.ReleaseState };
  let api: ReturnType<typeof fakes.installReleaseApi>;

  beforeEach(() => {
    setActivePinia(createPinia());
    state = { current: fakes.releaseState() };
    api = fakes.installReleaseApi(state);
    vi.mocked(feedback.showToast).mockClear();
    vi.mocked(feedback.confirmAction).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('reloads on release events while entered and unsubscribes on leave', async () => {
    const store = useReleaseStore();
    await store.enter();
    await store.generate();
    state.current = fakes.releaseState({ draft: fakes.draft() });
    api.get.mockClear();
    api.emitState({ repositoryId: null, domains: ['release'] });
    await flushPromises();
    expect(store.notesText).toBe('## 新增\n- 发布页');
    api.get.mockClear();
    store.leave();
    api.emitState({ repositoryId: null, domains: ['release'] });
    await Promise.resolve();
    expect(api.get).not.toHaveBeenCalled();
  });

  test('events arriving during a read cause one follow-up read without an endless refresh', async () => {
    const store = useReleaseStore();
    await store.enter();
    const held = Promise.withResolvers<Awaited<ReturnType<typeof api.get>>>();
    api.get.mockReturnValueOnce(held.promise);
    api.get.mockClear();
    api.emitState({ repositoryId: null, domains: ['release'] });
    state.current = fakes.releaseState({ draft: fakes.draft({ notesText: 'Latest committed notes' }) });
    api.emitState({ repositoryId: null, domains: ['release'] });
    held.resolve({ ok: true, data: fakes.releaseState() });
    await flushPromises();
    expect(store.notesText).toBe('Latest committed notes');
    expect(api.get).toHaveBeenCalledTimes(2);
    store.leave();
  });

  test('a start point of kind none needs a picked commit before generating', async () => {
    state.current = fakes.releaseState({ startPoint: { kind: 'none', commit: null, label: null } });
    const store = useReleaseStore();
    await store.enter();
    await flushPromises();
    expect(store.commits).toHaveLength(2);

    await store.generate();
    expect(api.generate).not.toHaveBeenCalled();
    expect(store.startError).toBe('请先选择从哪个提交开始。');

    store.selectStart('deadbeef99');
    expect(store.startError).toBeNull();
    await store.generate();
    expect(api.generate).toHaveBeenCalledWith('deadbeef99');

    // A start commit the main process refuses shows under the picker, not as a toast.
    api.generate.mockReturnValueOnce(fakes.fail('invalid_argument', '请选择最近的提交', 'startCommit') as never);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await store.generate();
    log.mockRestore();
    expect(store.startError).toBe('请选择最近的提交');
    expect(feedback.showToast).not.toHaveBeenCalled();
    store.leave();
  });

  test('checklist and notes edits send exactly the changed field', async () => {
    vi.useFakeTimers();
    state.current = fakes.releaseState({ draft: fakes.draft({ checked: [1] }) });
    const store = useReleaseStore();
    await store.enter();

    await store.setChecked(0, true);
    expect(api.updateDraft).toHaveBeenLastCalledWith({ checked: [0, 1] });
    await store.setChecked(1, false);
    expect(api.updateDraft).toHaveBeenLastCalledWith({ checked: [0] });

    store.editNotes('新的说明');
    expect(store.notesStatus).toBe('dirty');
    await vi.advanceTimersByTimeAsync(800);
    expect(api.updateDraft).toHaveBeenLastCalledWith({ notes: '新的说明' });
    expect(store.notesStatus).toBe('saved');
    // A save on blur with nothing pending sends nothing.
    const calls = api.updateDraft.mock.calls.length;
    await store.flushNotes();
    expect(api.updateDraft).toHaveBeenCalledTimes(calls);
  });

  test('finish needs every item checked, then confirms and records', async () => {
    state.current = fakes.releaseState({ draft: fakes.draft({ checked: [0] }) });
    const store = useReleaseStore();
    await store.enter();
    expect(store.canFinish).toBe(false);
    await store.finish();
    expect(api.finish).not.toHaveBeenCalled();

    await store.setChecked(1, true);
    expect(store.canFinish).toBe(true);
    vi.mocked(feedback.confirmAction).mockResolvedValueOnce(false);
    await store.finish();
    expect(api.finish).not.toHaveBeenCalled();

    await store.finish();
    expect(api.finish).toHaveBeenCalledTimes(1);
    expect(feedback.showToast).toHaveBeenLastCalledWith('已记录发布 0.2.0');
  });

  test('writing notes validates the path and keeps failures for the dialog', async () => {
    state.current = fakes.releaseState({ draft: fakes.draft() });
    const store = useReleaseStore();
    await store.enter();

    expect(await store.writeNotes('notes.txt')).toBe(false);
    expect(store.writeError).toBe('只能写入 .md 文件。');
    expect(api.writeNotes).not.toHaveBeenCalled();

    api.writeNotes.mockReturnValueOnce(fakes.fail('path_outside_workspace', 'Path is outside the workspace', 'path'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await store.writeNotes('../x.md')).toBe(false);
    log.mockRestore();
    expect(store.writeError).toBe('路径不在工作区内。');
    expect(feedback.showToast).not.toHaveBeenCalled();

    expect(await store.writeNotes(' docs/CHANGELOG.md ')).toBe(true);
    expect(api.writeNotes).toHaveBeenLastCalledWith({ path: 'docs/CHANGELOG.md' });
    expect(store.writeError).toBeNull();
    expect(feedback.showToast).toHaveBeenLastCalledWith('已写入 docs/CHANGELOG.md');
  });

  test('copy puts the edited notes on the clipboard', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    state.current = fakes.releaseState({ draft: fakes.draft() });
    const store = useReleaseStore();
    await store.enter();
    store.editNotes('改过的说明');
    await store.copyNotes();
    expect(writeText).toHaveBeenCalledWith('改过的说明');
    expect(feedback.showToast).toHaveBeenLastCalledWith('已复制更新说明');

    writeText.mockRejectedValueOnce(new Error('denied'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await store.copyNotes();
    log.mockRestore();
    expect(feedback.showToast).toHaveBeenLastCalledWith('复制失败：系统剪贴板不可用', 'error');
    store.leave();
  });
});
