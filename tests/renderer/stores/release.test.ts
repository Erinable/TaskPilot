// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

import * as feedback from '../../../src/renderer/src/lib/feedback.ts';
import * as model from '../../../src/renderer/src/lib/release_model.ts';
import { useReleaseStore } from '../../../src/renderer/src/stores/release.ts';
import * as fakes from '../release_fakes.ts';
import type * as ipc from '../../../src/shared/ipc_types.ts';

vi.mock('../../../src/renderer/src/lib/feedback.ts', () => ({ showToast: vi.fn(), confirmAction: vi.fn(async () => true), openDialogs: { value: 0 } }));

describe('release store', () => {
  let state: { current: ipc.ReleaseState };
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

  test('polls only while generating and stops on leave', async () => {
    vi.useFakeTimers();
    const store = useReleaseStore();
    await store.enter();
    expect(api.get).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(model.POLL_MS * 3);
    expect(api.get).toHaveBeenCalledTimes(1);

    await store.generate();
    expect(api.generate).toHaveBeenCalledWith(undefined);
    await vi.advanceTimersByTimeAsync(model.POLL_MS);
    expect(api.get).toHaveBeenCalledTimes(2);

    // The draft becomes ready: polling stops by itself.
    state.current = fakes.releaseState({ draft: fakes.draft() });
    await vi.advanceTimersByTimeAsync(model.POLL_MS);
    expect(api.get).toHaveBeenCalledTimes(3);
    expect(store.notesText).toBe('## 新增\n- 发布页');
    await vi.advanceTimersByTimeAsync(model.POLL_MS * 3);
    expect(api.get).toHaveBeenCalledTimes(3);

    // Leaving mid-generation stops the timer.
    await store.generate();
    store.leave();
    await vi.advanceTimersByTimeAsync(model.POLL_MS * 3);
    expect(api.get).toHaveBeenCalledTimes(3);
  });

  test('a start point of kind none needs a picked commit before generating', async () => {
    state.current = fakes.releaseState({ startPoint: { kind: 'none', commit: null, label: null } });
    const store = useReleaseStore();
    await store.enter();
    await vi.waitFor(() => expect(store.commits).toHaveLength(2));

    await store.generate();
    expect(api.generate).not.toHaveBeenCalled();
    expect(store.startError).toBe('请先选择从哪个提交开始。');

    store.selectStart('deadbeef99');
    expect(store.startError).toBeNull();
    await store.generate();
    expect(api.generate).toHaveBeenCalledWith('deadbeef99');

    // A start commit the main process refuses shows under the picker, not as a toast.
    api.generate.mockReturnValueOnce(fakes.fail('invalid_argument', '请选择最近的提交', 'startCommit') as never);
    await store.generate();
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

    api.writeNotes.mockReturnValueOnce(fakes.fail('outside_workspace', '路径不在工作区内', 'path') as never);
    expect(await store.writeNotes('../x.md')).toBe(false);
    expect(store.writeError).toBe('路径不在工作区内');
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
    await store.copyNotes();
    expect(feedback.showToast).toHaveBeenLastCalledWith('复制失败：系统剪贴板不可用', 'error');
    store.leave();
  });
});
