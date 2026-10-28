// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises } from '@vue/test-utils';

import { useRequirementsStore } from '../../../src/renderer/src/stores/requirements.ts';
import { useAppStore } from '../../../src/renderer/src/stores/app.ts';
import * as model from '../../../src/renderer/src/components/requirements/requirement_model.ts';
import * as feedback from '../../../src/renderer/src/lib/feedback.ts';
import { describeErrorInfo } from '../../../src/renderer/src/lib/errors.ts';
import { inlineCodeParts } from '../../../src/renderer/src/lib/inline_code.ts';
import { installApi, requirement } from '../requirements_fakes.ts';
import type * as requirementTypes from '../../../src/shared/ipc/requirements.ts';
import { expectConsole } from '../../fixtures/expected_console.ts';
vi.mock('../../../src/renderer/src/lib/feedback.ts', () => {
  const showToast = vi.fn();
  // announceAgent adds a system notification only in the background; tests see the toast.
  return { showToast, announceAgent: (...args: unknown[]) => showToast(...args), confirmAction: vi.fn(async () => true), openDialogs: { value: 0 } };
});

describe('requirement model', () => {
  test.each([
    ['draft', '草稿', 'pending'],
    ['clarifying', '澄清中', 'in_progress'],
    ['answering', '待回答', 'in_review'],
    ['planning', '拆解中', 'in_progress'],
    ['reviewing', '待确认', 'in_review'],
    ['published', '已发布', 'done'],
    ['failed', '失败', 'blocked'],
  ])('status %s has its label and tone', (status, label, tone) => {
    const key = status as keyof typeof model.STATUS_LABELS;
    expect(model.STATUS_LABELS[key]).toBe(label);
    expect(model.STATUS_TONES[key]).toBe(tone);
  });

  test.each([
    ['draft', 'clarify', []],
    ['answering', 'answer', ['clarify']],
    ['planning', 'plan', ['clarify', 'answer']],
    ['reviewing', 'publish', ['clarify', 'answer', 'plan']],
    ['published', null, ['clarify', 'answer', 'plan', 'publish']],
  ])('stepper marks %s', (status, current, done) => {
    expect(model.stepperState({ status: status as never, failedStep: null })).toEqual({ current, done });
  });
  test.each<[requirementTypes.RequirementStatus, requirementTypes.RequirementStep | null, model.StepName, boolean]>([
    ['failed', 'planning', 'plan', true],
    ['failed', 'planning', 'answer', false],
    ['failed', 'clarifying', 'clarify', true],
    ['planning', null, 'plan', false],
  ])('step classes mark failed %s/%s', (status, failedStep, step, failed) => {
    expect(model.stepClasses({ status, failedStep }, step).failed).toBe(failed);
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
    expect(describeErrorInfo({ code: 'unknown', message: 'boom' })).toBe('boom');
    expect(describeErrorInfo(null)).toBe('');
  });

  test('inline code splits into text and code parts', () => {
    expect(inlineCodeParts('call `run()` now')).toEqual([
      { text: 'call ', code: false },
      { text: 'run()', code: true },
      { text: ' now', code: false },
    ]);
  });

  test('course labs expose their phase labels', () => {
    const lab = { status: 'running' as const, phase: 'code' as const };
    const course = requirement({ kind: 'course', status: 'published', course: { lab } as never });
    expect(model.isCourse(course)).toBe(true);
    expect(model.LAB_PHASE_LABELS.code).toContain('参考解');
  });

  test('the lab estimate reads as a dollar range, or as tokens when no price is known', () => {
    const estimate = {
      concepts: [],
      difficulty: 'easy' as const,
      calls: 2,
      tokens: { input: 30500, output: 26000 },
      model: null,
      usd: { low: 0.4, high: 1.355 },
    };
    expect(model.estimateText(estimate)).toBe('约 $0.40–$1.35');
    expect(model.estimateText({ ...estimate, usd: null })).toBe('价格未知（默认模型，约 31k 输入 + 26k 输出 token）');
    expect(model.DIFFICULTY_LABELS.medium).toBe('中等');
  });
});

describe('requirements store', () => {
  let state: { list: ReturnType<typeof requirement>[] };
  let api: ReturnType<typeof installApi>;

  beforeEach(() => {
    setActivePinia(createPinia());
    state = { list: [] };
    api = installApi(state);
    vi.mocked(feedback.showToast).mockClear();
  });

  afterEach(() => {
    useRequirementsStore().stopWatching();
  });

  test('attentionCount counts answering, reviewing and failed', async () => {
    state.list = ['draft', 'clarifying', 'answering', 'planning', 'reviewing', 'published', 'failed'].map((status, index) =>
      requirement({ id: `r${index}`, status: status as never }),
    );
    const store = useRequirementsStore();
    await store.refreshList();
    expect(store.attentionCount).toBe(3);
  });

  test('a step request runs once while in flight and then clears', async () => {
    state.list = [requirement({ status: 'failed' })];
    const store = useRequirementsStore();
    await store.refreshList();
    const first = store.runStep(state.list[0], 'clarify');
    expect(store.acting).toBe('clarify');
    await store.runStep(state.list[0], 'clarify');
    await first;
    expect(api.requirements.clarify).toHaveBeenCalledTimes(1);
    expect(store.acting).toBe(null);
    store.stopWatching();
  });

  test('a failed list load keeps the last list', async () => {
    state.list = [requirement()];
    const store = useRequirementsStore();
    await store.refreshList();
    api.requirements.list.mockResolvedValueOnce({ ok: false, error: { code: 'x', message: 'x' } } as never);
    expectConsole('error', /Failed to load requirements/);
    await store.refreshList();
    expect(store.items.map((item) => item.id)).toEqual(['r1']);
  });

  test('init loads the list without subscribing to state events', async () => {
    state.list = [requirement({ status: 'clarifying' })];
    const store = useRequirementsStore();
    await store.init();
    api.requirements.list.mockClear();
    api.emitState({ repositoryId: null, domains: ['requirements'] });
    await Promise.resolve();
    expect(api.requirements.list).not.toHaveBeenCalled();
  });

  test('state events update the open requirement and announce status changes', async () => {
    state.list = [requirement({ status: 'clarifying' })];
    const store = useRequirementsStore();
    await store.open();
    expect(useAppStore().view).toBe('requirements');
    expect(store.pane).toBe('detail');
    const revision = store.detailRevision;
    api.requirements.list.mockClear();

    state.list = [requirement({ status: 'clarifying', phase: 'product-lead' })];
    api.emitState({ repositoryId: null, domains: ['requirements'] });
    await flushPromises();
    expect(store.detailRevision).toBe(revision + 1);
    expect(feedback.showToast).not.toHaveBeenCalled();

    state.list = [requirement({ status: 'answering' })];
    api.emitState({ repositoryId: null, domains: ['requirements'] });
    await flushPromises();
    expect(store.current?.status).toBe('answering');
    expect(feedback.showToast).toHaveBeenCalledWith('Product Lead 提出了澄清问题，等你回答。', 'info');
  });

  test('state events ignore unrelated domains and repositories, then stop after unsubscribe', async () => {
    state.list = [requirement({ status: 'clarifying' })];
    const store = useRequirementsStore();
    await store.open();
    api.requirements.list.mockClear();
    state.list = [requirement({ status: 'answering' })];
    api.emitState({ repositoryId: 'other-repo', domains: ['requirements'] });
    api.emitState({ repositoryId: null, domains: ['workspace'] });
    await Promise.resolve();
    expect(api.requirements.list).not.toHaveBeenCalled();
    store.stopWatching();
    api.emitState({ repositoryId: null, domains: ['requirements'] });
    await Promise.resolve();
    expect(api.requirements.list).not.toHaveBeenCalled();
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

  test('a valid submission creates, opens and watches the new requirement', async () => {
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
    expect(api.state.onChanged).toHaveBeenCalled();
  });

  test('a text error from the main process shows under the field, others as a toast', async () => {
    const store = useRequirementsStore();
    store.composeText = '需求';
    api.requirements.create.mockResolvedValueOnce({ ok: false, error: { code: 'too_long', message: 'x', field: 'text' } } as never);
    await store.submitNew();
    expect(store.composeStatus).toEqual({ text: '内容太长了。', error: true });
    expectConsole('error', /IpcError: x/);
    api.requirements.create.mockResolvedValueOnce({ ok: false, error: { code: 'agent_failed', message: 'x' } } as never);
    await store.submitNew();
    expect(feedback.showToast).toHaveBeenCalledWith('提交失败：智能体运行失败。');
  });

  test('publishing reloads the work queue', async () => {
    const store = useRequirementsStore();
    const item = requirement({ status: 'reviewing' });
    state.list = [item];
    await store.refreshList();
    store.select(item.id);
    expect(await store.publishPlan(item)).toBe(true);
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
    const item = requirement({ status: 'reviewing', questions: [{ text: 'q', answer: 'a' }] });
    state.list = [item];
    await store.refreshList();
    store.select(item.id);
    await store.editAnswers(item);
    expect(api.requirements.answer).toHaveBeenCalledWith('r1', ['a']);
    expect(store.current?.status).toBe('answering');
  });
});
