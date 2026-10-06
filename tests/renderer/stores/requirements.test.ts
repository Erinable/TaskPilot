// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

import { useRequirementsStore } from '../../../src/renderer/src/stores/requirements.ts';
import { useAppStore } from '../../../src/renderer/src/stores/app.ts';
import * as model from '../../../src/renderer/src/components/requirements/requirement_model.ts';
import * as feedback from '../../../src/renderer/src/lib/feedback.ts';
import { describeErrorInfo } from '../../../src/renderer/src/lib/errors.ts';
import { inlineCodeParts } from '../../../src/renderer/src/lib/inline_code.ts';
import { installApi, requirement } from '../requirements_fakes.ts';

vi.mock('../../../src/renderer/src/lib/feedback.ts', () => ({ showToast: vi.fn(), confirmAction: vi.fn(async () => true), openDialogs: { value: 0 } }));

describe('requirement model', () => {
  test('every status has a pill label and tone', () => {
    expect(model.STATUS_LABELS).toEqual({ draft: '草稿', clarifying: '澄清中', answering: '待回答', planning: '拆解中', reviewing: '待确认', published: '已发布', failed: '失败' });
    expect(model.STATUS_TONES).toEqual({ draft: 'pending', clarifying: 'in_progress', answering: 'in_review', planning: 'in_progress', reviewing: 'in_review', published: 'done', failed: 'blocked' });
  });

  test('stepper marks done and current steps per status', () => {
    expect(model.stepperState({ status: 'draft', failedStep: null })).toEqual({ current: 'clarify', done: [] });
    expect(model.stepperState({ status: 'answering', failedStep: null })).toEqual({ current: 'answer', done: ['clarify'] });
    expect(model.stepperState({ status: 'planning', failedStep: null })).toEqual({ current: 'plan', done: ['clarify', 'answer'] });
    expect(model.stepperState({ status: 'reviewing', failedStep: null })).toEqual({ current: 'publish', done: ['clarify', 'answer', 'plan'] });
    expect(model.stepperState({ status: 'published', failedStep: null })).toEqual({ current: null, done: ['clarify', 'answer', 'plan', 'publish'] });
  });

  test('a failure marks the step it failed at', () => {
    expect(model.stepClasses({ status: 'failed', failedStep: 'planning' }, 'plan')).toEqual({ done: false, current: true, failed: true });
    expect(model.stepClasses({ status: 'failed', failedStep: 'planning' }, 'answer')).toEqual({ done: true, current: false, failed: false });
    expect(model.stepClasses({ status: 'failed', failedStep: 'clarifying' }, 'clarify')).toEqual({ done: false, current: true, failed: true });
    expect(model.stepClasses({ status: 'planning', failedStep: null }, 'plan').failed).toBe(false);
  });

  test('text validation: required, and at most 4000 code points', () => {
    expect(model.validateText('   ')).toBe('请先描述需求。');
    expect(model.validateText('a'.repeat(4000))).toBeNull();
    expect(model.validateText('a'.repeat(4001))).toBe('最多 4000 个字符。');
    // Astral characters are one code point each but two UTF-16 units.
    expect(model.validateText('😀'.repeat(4000))).toBeNull();
    expect(model.countChars(' 😀a ')).toBe(2);
  });

  test('stored errors use the shared wording, falling back to the message', () => {
    expect(describeErrorInfo({ code: 'agent_timeout', message: 'x' })).toBe('智能体超过 3 分钟没有完成，已停止。');
    expect(describeErrorInfo({ code: 'weird', message: 'boom' })).toBe('boom');
    expect(describeErrorInfo(null)).toBe('');
  });

  test('inline code splits into text and code parts', () => {
    expect(inlineCodeParts('call `run()` now')).toEqual([{ text: 'call ', code: false }, { text: 'run()', code: true }, { text: ' now', code: false }]);
  });
});

describe('requirements store', () => {
  let state: { list: ReturnType<typeof requirement>[] };
  let api: ReturnType<typeof installApi>;

  beforeEach(() => {
    vi.useFakeTimers();
    setActivePinia(createPinia());
    state = { list: [] };
    api = installApi(state);
    vi.mocked(feedback.showToast).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('attentionCount counts answering, reviewing and failed', async () => {
    state.list = ['draft', 'clarifying', 'answering', 'planning', 'reviewing', 'published', 'failed'].map((status, index) => requirement({ id: `r${index}`, status: status as never }));
    const store = useRequirementsStore();
    await store.refreshList();
    expect(store.attentionCount).toBe(3);
  });

  test('a failed list load keeps the last list', async () => {
    state.list = [requirement()];
    const store = useRequirementsStore();
    await store.refreshList();
    api.requirements.list.mockResolvedValueOnce({ ok: false, error: { code: 'x', message: 'x' } } as never);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await store.refreshList();
    expect(store.items.map((item) => item.id)).toEqual(['r1']);
    spy.mockRestore();
  });

  test('init polls while something runs and stops once nothing does', async () => {
    state.list = [requirement({ status: 'clarifying' })];
    const store = useRequirementsStore();
    await store.init();
    expect(store.isPolling()).toBe(true);
    expect(store.pane).toBeNull();
    await vi.advanceTimersByTimeAsync(model.POLL_MS);
    expect(api.requirements.list).toHaveBeenCalledTimes(2);
    expect(store.isPolling()).toBe(true);
    state.list = [requirement({ status: 'answering' })];
    await vi.advanceTimersByTimeAsync(model.POLL_MS);
    expect(store.isPolling()).toBe(false);
    await vi.advanceTimersByTimeAsync(model.POLL_MS * 3);
    expect(api.requirements.list).toHaveBeenCalledTimes(3);
  });

  test('init does not poll when nothing is running', async () => {
    state.list = [requirement({ status: 'answering' })];
    const store = useRequirementsStore();
    await store.init();
    expect(store.isPolling()).toBe(false);
  });

  test('polling re-renders the open requirement and announces it only when its status changes', async () => {
    state.list = [requirement({ status: 'clarifying' })];
    const store = useRequirementsStore();
    await store.open();
    expect(useAppStore().view).toBe('requirements');
    expect(store.pane).toBe('detail');
    const revision = store.detailRevision;
    await vi.advanceTimersByTimeAsync(model.POLL_MS);
    expect(store.detailRevision).toBe(revision);
    state.list = [requirement({ status: 'clarifying', phase: 'product-lead' })];
    await vi.advanceTimersByTimeAsync(model.POLL_MS);
    expect(store.detailRevision).toBe(revision + 1);
    expect(feedback.showToast).not.toHaveBeenCalled();
    state.list = [requirement({ status: 'answering' })];
    await vi.advanceTimersByTimeAsync(model.POLL_MS);
    expect(store.current?.status).toBe('answering');
    expect(feedback.showToast).toHaveBeenCalledWith('Product Lead 提出了澄清问题。', 'info');
  });

  test('open selects the first requirement, or shows the empty pane', async () => {
    const store = useRequirementsStore();
    await store.open();
    expect(store.pane).toBe('empty');
    state.list = [requirement({ id: 'a' }), requirement({ id: 'b' })];
    await store.open();
    expect(store.selectedId).toBe('a');
    await store.open({ id: 'b' });
    expect(store.current?.id).toBe('b');
    await store.open({ compose: true });
    expect(store.pane).toBe('new');
    expect(store.composing).toBe(true);
  });

  test('submitting validates the text locally before calling the main process', async () => {
    const store = useRequirementsStore();
    await store.open({ compose: true });
    store.composeText = '  ';
    await store.submitNew();
    expect(store.composeStatus).toEqual({ text: '请先描述需求。', error: true });
    expect(store.composeInvalid).toBe(true);
    store.composeText = 'x'.repeat(4001);
    await store.submitNew();
    expect(store.composeStatus.text).toBe('最多 4000 个字符。');
    expect(api.requirements.create).not.toHaveBeenCalled();
    store.composeText = '写点东西';
    store.onComposeInput();
    expect(store.composeStatus).toEqual({ text: '', error: false });
    expect(store.composeInvalid).toBe(false);
  });

  test('a valid submission creates, opens and polls the new requirement', async () => {
    const store = useRequirementsStore();
    await store.open({ compose: true });
    store.composeTitle = '标题';
    store.composeText = '需求';
    await store.submitNew();
    expect(api.requirements.create).toHaveBeenCalledWith({ title: '标题', text: '需求' });
    expect(store.composeText).toBe('');
    expect(store.selectedId).toBe('new');
    expect(store.pane).toBe('detail');
    expect(store.items[0].id).toBe('new');
    expect(store.isPolling()).toBe(true);
  });

  test('a text error from the main process shows under the field, others as a toast', async () => {
    const store = useRequirementsStore();
    store.composeText = '需求';
    api.requirements.create.mockResolvedValueOnce({ ok: false, error: { code: 'too_long', message: 'x', field: 'text' } } as never);
    await store.submitNew();
    expect(store.composeStatus).toEqual({ text: '内容太长了。', error: true });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    api.requirements.create.mockResolvedValueOnce({ ok: false, error: { code: 'agent_failed', message: 'x' } } as never);
    await store.submitNew();
    expect(feedback.showToast).toHaveBeenCalledWith('提交失败：智能体运行失败。');
    spy.mockRestore();
  });

  test('publishing reloads the work queue', async () => {
    const store = useRequirementsStore();
    const item = requirement({ status: 'reviewing' });
    expect(await store.publishPlan(item)).toBe(true);
    expect(window.taskpilot.listTasks).toHaveBeenCalled();
    expect(feedback.showToast).toHaveBeenCalledWith('已发布 1 个工作包到工作队列。');
    expect(store.current?.status).toBe('published');
  });

  test('deleting asks first, then shows the empty pane', async () => {
    state.list = [requirement()];
    const store = useRequirementsStore();
    await store.open();
    vi.mocked(feedback.confirmAction).mockResolvedValueOnce(false);
    await store.removeRequirement(requirement());
    expect(api.requirements.remove).not.toHaveBeenCalled();
    state.list = [];
    await store.removeRequirement(requirement());
    expect(api.requirements.remove).toHaveBeenCalledWith('r1');
    expect(store.pane).toBe('empty');
    expect(store.selectedId).toBeNull();
    expect(feedback.showToast).toHaveBeenCalledWith('需求已删除。');
  });

  test('editing answers sends the stored answers back', async () => {
    const store = useRequirementsStore();
    await store.editAnswers(requirement({ status: 'reviewing', questions: [{ text: 'q', answer: 'a' }] }));
    expect(api.requirements.answer).toHaveBeenCalledWith('r1', ['a']);
    expect(store.current?.status).toBe('answering');
  });
});
