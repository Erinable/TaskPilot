// @vitest-environment happy-dom
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import ElementPlus from 'element-plus';

import PracticePanel from '../../../../src/renderer/src/components/execution/PracticePanel.vue';
import { useExecutionStore } from '../../../../src/renderer/src/stores/execution.ts';
import type * as packageTypes from '../../../../src/shared/ipc/packages.ts';
import { installApi, taskView } from '../../execution_fakes.ts';

vi.mock('../../../../src/renderer/src/lib/feedback.ts', () => {
  const showToast = vi.fn();
  return { showToast, announceAgent: showToast, confirmAction: vi.fn(async () => true), openDialogs: { value: 0 } };
});

const READY: packageTypes.ReferenceRun = {
  id: 'r1',
  status: 'ready',
  startedAt: '',
  finishedAt: '',
  error: null,
  files: [{ path: 'src/auth.ts', added: 1, removed: 0 }],
  costUsd: 0.2,
  revealedAt: null,
};
const REVIEWED = { status: 'rejected', startedAt: '', finishedAt: '', error: null } as unknown as packageTypes.Review;
const OPEN: packageTypes.ReferenceLock = { unlocked: true, reason: 'tests_passed' };
const GRADE: packageTypes.Grade = {
  id: 'g1',
  status: 'done',
  startedAt: '',
  finishedAt: '',
  error: null,
  diffDigest: 'd',
  withReference: true,
  costUsd: 0.05,
  report: {
    summary: '能跑通，边界情况少了一个。',
    strengths: ['函数名说清了用途'],
    comments: [
      { category: 'thinking', file: 'src/auth.ts', line: 4, observation: '没有考虑空密码。', betterWay: '先列出输入的几种情况再写代码。', repeated: true },
      { category: 'style', file: null, line: null, observation: '变量用了缩写。', betterWay: '写全名。', repeated: false },
    ],
  },
};

let current: { task: packageTypes.TaskView };
let api: ReturnType<typeof installApi>;

const mountPanel = async (overrides: Partial<packageTypes.TaskView>) => {
  current.task = taskView({ mode: 'practice', ...overrides });
  const pinia = createPinia();
  setActivePinia(pinia);
  await useExecutionStore().open('t1');
  const wrapper = mount(PracticePanel, { props: { task: current.task }, global: { plugins: [ElementPlus, pinia] } });
  await flushPromises();
  return wrapper;
};

beforeEach(() => {
  current = { task: taskView() };
  api = installApi(current);
});

describe('PracticePanel', () => {
  test('a ready reference stays locked until every test passed or the hints are used up', async () => {
    const before = await mountPanel({ referenceRun: READY, review: null, referenceLock: { unlocked: false, reason: 'not_submitted' } });
    expect(before.get('[data-reference-status]').text()).toContain('测试全部通过，或者提示用到 L5 之后才能看');
    expect(before.find('[data-reference]').exists()).toBe(false);
    // A submission that QA judged is not enough: its tests must all pass.
    const failing = await mountPanel({ referenceRun: READY, review: REVIEWED, grade: GRADE, referenceLock: { unlocked: false, reason: 'tests_not_passed' } });
    expect(failing.get('[data-reference-status]').text()).toContain('还有测试没通过');
    expect(failing.find('[data-reference]').exists()).toBe(false);
    expect(api.practice.reference).not.toHaveBeenCalled();
  });

  test('once unlocked, the grade shows by category and the reference can be read beside it', async () => {
    const wrapper = await mountPanel({ referenceRun: READY, review: REVIEWED, grade: GRADE, referenceLock: OPEN });
    expect(api.practice.reference).toHaveBeenCalledWith('t1');
    expect(wrapper.get('[data-category="thinking"]').text()).toContain('先列出输入的几种情况再写代码。');
    expect(wrapper.get('[data-category="thinking"]').text()).toContain('src/auth.ts:4');
    expect(wrapper.get('[data-category="style"]').text()).toContain('写全名。');
    expect(wrapper.find('[data-category="writing"]').exists()).toBe(false);
    expect(wrapper.get('[data-reference]').text()).toContain('+export const login = () => true;');
  });

  test('a grade made with another course pack shows that rubric, in its order, with its labels', async () => {
    const course = {
      id: 'os',
      version: '0.1.0',
      contentHash: 'h',
      rubric: [
        { id: 'mechanism', label: '实现', description: 'd', dimension: 'writing' as const },
        { id: 'concept', label: '原理', description: 'd', dimension: 'thinking' as const },
      ],
    };
    const comments = [
      { ...GRADE.report!.comments[0], category: 'concept', observation: '锁拿晚了。' },
      { ...GRADE.report!.comments[1], category: 'mechanism', observation: '漏了错误路径。' },
    ];
    const wrapper = await mountPanel({
      referenceRun: READY,
      review: REVIEWED,
      grade: { ...GRADE, course, report: { ...GRADE.report!, comments } },
      concepts: ['round-robin', 'priority-sched'],
    });
    const groups = wrapper.findAll('[data-category]');
    expect(groups.map((group) => group.attributes('data-category'))).toEqual(['mechanism', 'concept']);
    expect(groups.map((group) => group.get('h3').text())).toEqual(['实现', '原理']);
    expect(wrapper.get('[data-category="concept"]').text()).toContain('锁拿晚了。');
    await wrapper.get('[data-category="concept"] [data-action="save-note"]').trigger('click');
    await flushPromises();
    // The package's concepts come along.
    expect(api.notes.create).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'concept', course: 'os', concepts: ['round-robin', 'priority-sched'] }),
      true,
    );
  });

  test('a grade waiting on the reference can go ahead without it; a failed one can be retried', async () => {
    const waiting = await mountPanel({ referenceRun: { ...READY, status: 'running' }, review: REVIEWED, grade: { ...GRADE, status: 'waiting', report: null } });
    await waiting.get('[data-action="grade-now"]').trigger('click');
    expect(api.practice.grade).toHaveBeenCalledWith('t1', true);

    const failed = await mountPanel({
      referenceRun: READY,
      review: REVIEWED,
      grade: { ...GRADE, status: 'failed', report: null, error: { code: 'agent_timeout', message: '' } },
    });
    await failed.get('[data-action="regrade"]').trigger('click');
    expect(api.practice.grade).toHaveBeenLastCalledWith('t1', false);
  });

  test('a grade comment is saved as a note pointing back at the package and line, and repeats are marked', async () => {
    const wrapper = await mountPanel({ referenceRun: READY, review: REVIEWED, grade: GRADE });
    expect(wrapper.get('[data-category="thinking"] [data-repeated]').text()).toBe('又出现了');
    expect(wrapper.find('[data-category="style"] [data-repeated]').exists()).toBe(false);
    await wrapper.get('[data-category="thinking"] [data-action="save-note"]').trigger('click');
    await flushPromises();
    expect(api.notes.create).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'thinking',
        // A grade from before packs has no snapshot: programming.
        course: 'programming',
        // A package without concepts.
        concepts: [],
        body: '没有考虑空密码。\n\n## 下次可以\n\n先列出输入的几种情况再写代码。\n',
        source: expect.objectContaining({ packageId: 't1', packageTitle: '邮箱登录', file: 'src/auth.ts', line: 4 }),
      }),
      true,
    );
    expect(wrapper.get('[data-category="thinking"] [data-action="save-note"]').text()).toBe('已存为笔记');
  });

  test('agent text renders as text', async () => {
    const payload = '<img src=x onerror="alert(1)">';
    const wrapper = await mountPanel({ referenceRun: READY, review: REVIEWED, grade: { ...GRADE, report: { summary: payload, strengths: [], comments: [] } } });
    expect(wrapper.find('img').exists()).toBe(false);
    expect(wrapper.text()).toContain(payload);
  });

  test('an old grade without scores or an explanation shows neither, without failing', async () => {
    const wrapper = await mountPanel({ referenceRun: READY, review: REVIEWED, grade: GRADE, referenceLock: OPEN });
    expect(wrapper.find('[data-scores]').exists()).toBe(false);
    expect(wrapper.find('[data-action="explain"]').exists()).toBe(true);
  });

  test('both scores show with every line of their breakdown and what independence counts', async () => {
    const scores: packageTypes.GradeScores = {
      quality: 74,
      independence: 45,
      signals: {
        tests: { passed: 3, total: 4, points: 30 },
        qa: { passed: true, points: 20 },
        rubric: { points: 24 },
        hints: [
          { level: 2, deduction: 0 },
          { level: 3, deduction: 5 },
        ],
        reference: { beforePass: true, deduction: 40 },
        similarity: { ratio: 0.34, deduction: 10 },
      },
    };
    const report = { ...GRADE.report!, levels: { thinking: 3, writing: 2, style: 4 } };
    const wrapper = await mountPanel({ referenceRun: READY, review: REVIEWED, grade: { ...GRADE, report, scores }, referenceLock: OPEN });
    const quality = wrapper.get('[data-score="quality"]').text();
    expect(quality).toContain('74');
    expect(quality).toContain('3/4 通过，30/40 分');
    expect(quality).toContain('通过，20/20 分');
    expect(quality).toContain('思路3/4 级');
    const independence = wrapper.get('[data-score="independence"]').text();
    expect(independence).toContain('45');
    expect(independence).toContain('用了 L3 提示−5');
    expect(independence).not.toContain('L2');
    expect(independence).toContain('测试全过之前看了参考答案−40');
    expect(independence).toContain('和看过的代码雷同 34%−10');
    expect(wrapper.get('[data-independence-note]').text()).toContain('独立完成度只统计 TaskPilot 内的辅助');
  });

  test('explaining: each difference takes an answer, skipped ones go as null, then the result can be saved', async () => {
    const items: packageTypes.ExplanationItem[] = [
      { category: 'thinking', file: 'src/auth.ts', difference: '参考实现先处理空密码。', answer: null, feedback: null },
      { category: 'style', file: null, difference: '参考实现用了全名。', answer: null, feedback: null },
    ];
    const explanation: packageTypes.GradeExplanation = {
      status: 'answering',
      startedAt: '',
      finishedAt: null,
      error: null,
      items,
      completed: false,
      noteId: null,
      costUsd: 0,
    };
    const wrapper = await mountPanel({ referenceRun: READY, review: REVIEWED, grade: { ...GRADE, explanation }, referenceLock: OPEN });
    expect(wrapper.findAll('[data-difference]')).toHaveLength(2);
    await wrapper.get('[data-answer="0"]').setValue('  空密码会让后面的比较出错。 ');
    await wrapper.get('[data-action="answer"]').trigger('click');
    await flushPromises();
    expect(api.practice.answer).toHaveBeenCalledWith('t1', ['空密码会让后面的比较出错。', null]);

    const done = {
      ...explanation,
      status: 'done' as const,
      completed: true,
      items: [{ ...items[0], answer: '空密码', feedback: { correct: false, missed: '没说为什么要提前返回。' } }, { ...items[1] }],
    };
    const finished = await mountPanel({ referenceRun: READY, review: REVIEWED, grade: { ...GRADE, explanation: done }, referenceLock: OPEN });
    expect(finished.get('[data-feedback]').text()).toContain('漏了：没说为什么要提前返回。');
    expect(finished.text()).toContain('（跳过）');
    await finished.get('[data-action="save-explanation"]').trigger('click');
    expect(api.practice.saveExplanation).toHaveBeenCalledWith('t1');
  });

  test('a package Coding Agent wrote records no mastery, so the panel does not say it did', async () => {
    const wrapper = await mountPanel({ referenceRun: READY, review: REVIEWED, grade: GRADE, referenceLock: OPEN, mode: 'ai', concepts: ['round-robin'] });
    expect(wrapper.find('[data-field="mastery"]').exists()).toBe(false);
  });
});
