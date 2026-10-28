// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';

import ReleaseView from '../../../src/renderer/src/views/ReleaseView.vue';
import WriteNotesDialog from '../../../src/renderer/src/components/release/WriteNotesDialog.vue';
import * as feedback from '../../../src/renderer/src/lib/feedback.ts';
import { useSettingsStore } from '../../../src/renderer/src/stores/settings.ts';
import * as fakes from '../release_fakes.ts';
import type * as releaseTypes from '../../../src/shared/ipc/release.ts';

vi.mock('../../../src/renderer/src/lib/feedback.ts', () => {
  const showToast = vi.fn();
  // announceAgent adds a system notification only in the background; tests see the toast.
  return { showToast, announceAgent: (...args: unknown[]) => showToast(...args), confirmAction: vi.fn(async () => true), openDialogs: { value: 0 } };
});

describe('ReleaseView', () => {
  let state: { current: releaseTypes.ReleaseState };
  let api: ReturnType<typeof fakes.installReleaseApi>;
  let wrapper: ReturnType<typeof mount> | null = null;

  beforeEach(() => {
    setActivePinia(createPinia());
    state = { current: fakes.releaseState() };
    api = fakes.installReleaseApi(state);
    vi.mocked(feedback.showToast).mockClear();
  });

  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
    document.body.replaceChildren();
    vi.useRealTimers();
  });

  const render = async () => {
    wrapper = mount(ReleaseView, { attachTo: document.body, global: { plugins: [ElementPlus] } });
    await flushPromises();
    return wrapper;
  };

  test('without a workspace it points to the repository settings', async () => {
    state.current = fakes.releaseState({ configured: false, startPoint: null });
    const open = vi.spyOn(useSettingsStore(), 'open').mockResolvedValue();
    const view = await render();
    expect(view.find('.generate-release').exists()).toBe(false);
    await view.find('.no-workspace button').trigger('click');
    expect(open).toHaveBeenCalledWith('repository');
  });

  test('generating shows a spinner and state events stop on unmount', async () => {
    const view = await render();
    await view.find('.generate-release').trigger('click');
    await flushPromises();
    expect(view.find('.generating').exists()).toBe(true);
    state.current = fakes.releaseState({ draft: fakes.draft() });
    api.get.mockClear();
    api.emitState({ repositoryId: null, domains: ['release'] });
    await flushPromises();
    expect(api.get).toHaveBeenCalled();
    view.unmount();
    wrapper = null;
    api.get.mockClear();
    api.emitState({ repositoryId: null, domains: ['release'] });
    await Promise.resolve();
    expect(api.get).not.toHaveBeenCalled();
  });

  test('a failed draft shows the error and 重试', async () => {
    state.current = fakes.releaseState({ draft: fakes.draft({ status: 'failed', plan: null, error: { code: 'agent_timeout', message: 'timeout' } }) });
    const view = await render();
    expect(view.find('.draft-error').text()).toBe('智能体超过 3 分钟没有完成，已停止。');
  });

  test('kind none lists recent commits as text and requires a pick', async () => {
    state.current = fakes.releaseState({ startPoint: { kind: 'none', commit: null, label: null } });
    const view = await render();
    await view.find('.generate-release').trigger('click');
    await flushPromises();
    expect(api.generate).not.toHaveBeenCalled();
    expect(view.find('.start-error').text()).toBe('请先选择从哪个提交开始。');

    await view.find('.start-select .el-select__wrapper').trigger('click');
    await flushPromises();
    const options = document.querySelectorAll('.el-select-dropdown__item');
    expect(options).toHaveLength(2);
    expect(options[0].textContent).toContain('<b>初始提交</b>');
    expect(document.querySelector('.el-select-dropdown__item b')).toBeNull();
    (options[1] as HTMLElement).click();
    await flushPromises();
    await view.find('.generate-release').trigger('click');
    await flushPromises();
    expect(api.generate).toHaveBeenCalledWith('deadbeef99');
  });

  test('a ready draft: version, notes, checklist gates 完成发布, model text stays text', async () => {
    state.current = fakes.releaseState({
      draft: fakes.draft({
        plan: fakes.plan({
          reason: '<img src=x onerror=alert(1)>',
          checklist: [
            { text: '<script>x</script>', evidence: ['<i>src/a.ts</i>'] },
            { text: '更新 README', evidence: [] },
          ],
        }),
      }),
    });
    const view = await render();
    expect(view.find('.start-line').text()).toBe('从上次发布 0.1.0 开始（12 个提交，2 个完成的工作包）');
    expect(view.find('.version-from').text()).toBe('0.1.0');
    expect(view.find('.version-next').text()).toBe('0.2.0');
    expect(view.find('.version-reason').text()).toContain('<img src=x onerror=alert(1)>');
    expect(view.find('.release-view img').exists()).toBe(false);
    expect(view.find('.checklist-item script').exists()).toBe(false);
    expect(view.find('.evidence code').text()).toBe('<i>src/a.ts</i>');
    expect((view.find('.notes-editor textarea').element as HTMLTextAreaElement).value).toBe('## 新增\n- 发布页');

    const finish = view.find('.finish-release');
    expect(finish.attributes('disabled')).toBeDefined();
    const boxes = view.findAll('.checklist-item input[type="checkbox"]');
    await boxes[0].setValue(true);
    await flushPromises();
    expect(api.updateDraft).toHaveBeenLastCalledWith({ checked: [0] });
    expect(view.find('.finish-release').attributes('disabled')).toBeDefined();
    await boxes[1].setValue(true);
    await flushPromises();
    expect(api.updateDraft).toHaveBeenLastCalledWith({ checked: [0, 1] });
    expect(view.find('.finish-release').attributes('disabled')).toBeUndefined();
    await view.find('.finish-release').trigger('click');
    await flushPromises();
    expect(api.finish).toHaveBeenCalled();
  });

  test('notes save on blur and show 已保存', async () => {
    state.current = fakes.releaseState({ draft: fakes.draft() });
    const view = await render();
    const textarea = view.find('.notes-editor textarea');
    await textarea.setValue('## 改过');
    await textarea.trigger('blur');
    await flushPromises();
    expect(api.updateDraft).toHaveBeenLastCalledWith({ notes: '## 改过' });
    expect(view.find('.notes-status').text()).toBe('已保存');
  });

  test('write-notes dialog: error under the input, success closes with a toast', async () => {
    state.current = fakes.releaseState({ draft: fakes.draft() });
    const view = await render();
    await view.find('.write-notes').trigger('click');
    await flushPromises();
    const dialog = () => document.querySelector('.release-write-dialog') as HTMLElement;
    expect(dialog()).not.toBeNull();

    api.writeNotes.mockReturnValueOnce(fakes.fail('outside_workspace', '路径不在工作区内', 'path') as never);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    (dialog().querySelector('.write-confirm') as HTMLElement).click();
    await flushPromises();
    log.mockRestore();
    expect(api.writeNotes).toHaveBeenLastCalledWith({ path: 'CHANGELOG.md' });
    expect(dialog().querySelector('#release-notes-path-error')!.textContent).toBe('路径不在工作区内');

    (dialog().querySelector('.write-confirm') as HTMLElement).click();
    await flushPromises();
    expect(feedback.showToast).toHaveBeenLastCalledWith('已写入 CHANGELOG.md');
    expect(view.findComponent(WriteNotesDialog).props('modelValue')).toBe(false);
  });

  test('复制说明 copies the editor text', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    state.current = fakes.releaseState({ draft: fakes.draft() });
    const view = await render();
    await view.find('.copy-notes').trigger('click');
    await flushPromises();
    expect(writeText).toHaveBeenCalledWith('## 新增\n- 发布页');
  });

  test('history: newest first, business-time dates, expandable, capped at 20', async () => {
    const history = Array.from({ length: 23 }, (_, index) =>
      fakes.release({ id: `r${index}`, version: `0.${23 - index}.0`, notesText: index === 0 ? '<b>说明</b>' : '说明' }),
    );
    state.current = fakes.releaseState({ history });
    const view = await render();
    const rows = view.findAll('.history-row');
    expect(rows).toHaveLength(20);
    expect(rows[0].find('.history-version').text()).toBe('0.23.0');
    expect(rows[0].find('time').text()).toBe('2026-10-01 12:05:06');
    await rows[0].find('.history-summary').trigger('click');
    expect(view.find('.history-notes').text()).toBe('<b>说明</b>');
    expect(view.find('.history-notes b').exists()).toBe(false);
    await view.find('.release-history .view-all-button').trigger('click');
    expect(view.findAll('.history-row')).toHaveLength(23);
  });

  const milestone = (overrides: Partial<releaseTypes.MilestoneView> = {}): releaseTypes.MilestoneView => ({
    id: 'ms1',
    version: '0.3.0',
    targetDate: null,
    requirementIds: ['r1', 'r2'],
    createdAt: '',
    releasedAt: null,
    requirements: [
      { id: 'r1', title: '邮箱登录', done: 2, total: 2 },
      { id: 'r2', title: '发票邮件', done: 1, total: 4 },
    ],
    done: 3,
    total: 6,
    complete: false,
    ...overrides,
  });

  test('version plans show progress per requirement, and an empty page invites one', async () => {
    let view = await render();
    expect(view.find('.milestone-panel .empty-hint').exists()).toBe(true);
    view.unmount();
    state.current = fakes.releaseState({ milestones: [milestone()] });
    view = await render();
    const card = view.find('[data-milestone="0.3.0"]');
    expect(card.find('.milestone-count').text()).toBe('3/6 个工作包');
    expect(card.find('[role="progressbar"]').attributes('aria-valuenow')).toBe('50');
    expect(card.findAll('.milestone-requirements li')).toHaveLength(2);
  });

  test('a finished plan starts the release draft', async () => {
    state.current = fakes.releaseState({ milestones: [milestone({ done: 6, complete: true })] });
    const view = await render();
    await view.find('.milestone-ready button').trigger('click');
    await flushPromises();
    expect(api.generate).toHaveBeenCalled();
  });

  test('creating a plan sends the version and date', async () => {
    const view = await render();
    await view.find('.milestone-panel .panel-heading button').trigger('click');
    await view.find('.milestone-form input[aria-label="版本号"]').setValue('0.4.0');
    await view.find('.milestone-form').trigger('submit');
    await flushPromises();
    expect(api.createMilestone).toHaveBeenCalledWith({ version: '0.4.0', targetDate: null, requirementIds: [] });
    expect(view.find('.milestone-form').exists()).toBe(false);
    expect(view.find('[data-milestone="0.4.0"]').exists()).toBe(true);
  });
});
