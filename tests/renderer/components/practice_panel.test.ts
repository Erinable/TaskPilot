// @vitest-environment happy-dom
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import ElementPlus from 'element-plus';

import PracticePanel from '../../../src/renderer/src/components/execution/PracticePanel.vue';
import { useExecutionStore } from '../../../src/renderer/src/stores/execution.ts';
import type * as packageTypes from '../../../src/shared/ipc/packages.ts';
import { installApi, taskView } from '../execution_fakes.ts';

vi.mock('../../../src/renderer/src/lib/feedback.ts', () => {
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
  test('a ready reference stays locked until the first submission', async () => {
    const wrapper = await mountPanel({ referenceRun: READY, review: null });
    expect(wrapper.get('[data-reference-status]').text()).toContain('交卷后解锁');
    expect(wrapper.find('[data-reference]').exists()).toBe(false);
    expect(api.practice.reference).not.toHaveBeenCalled();
  });

  test('after QA, the grade shows by category and the reference can be read beside it', async () => {
    const wrapper = await mountPanel({ referenceRun: READY, review: REVIEWED, grade: GRADE });
    expect(api.practice.reference).toHaveBeenCalledWith('t1');
    expect(wrapper.get('[data-category="thinking"]').text()).toContain('先列出输入的几种情况再写代码。');
    expect(wrapper.get('[data-category="thinking"]').text()).toContain('src/auth.ts:4');
    expect(wrapper.get('[data-category="style"]').text()).toContain('写全名。');
    expect(wrapper.find('[data-category="writing"]').exists()).toBe(false);
    expect(wrapper.get('[data-reference]').text()).toContain('+export const login = () => true;');
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
});
