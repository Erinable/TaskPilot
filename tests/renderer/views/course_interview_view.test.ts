// @vitest-environment happy-dom
// The course interview in the requirement center: the "我想学…" form, picking
// a pack, adjusting the path and the drafted pack.
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises } from '@vue/test-utils';

import { mountView } from '../mount_view.ts';
import RequirementsView from '../../../src/renderer/src/views/RequirementsView.vue';
import { useRequirementsStore } from '../../../src/renderer/src/stores/requirements.ts';
import { LAB_ESTIMATE, courseInterview, coursePathInterview, installApi, labGeneration, requirement } from '../requirements_fakes.ts';
import { OS_COURSE } from '../../fixtures/builtin_courses.ts';
import type * as requirementTypes from '../../../src/shared/ipc/requirements.ts';

vi.mock('../../../src/renderer/src/lib/feedback.ts', () => {
  const showToast = vi.fn();
  return { showToast, announceAgent: (...args: unknown[]) => showToast(...args), confirmAction: vi.fn(async () => true), openDialogs: { value: 0 } };
});

const MARKUP = '<img src=x onerror="alert(1)">';

describe('course interview', () => {
  let state: { list: ReturnType<typeof requirement>[] };
  let api: ReturnType<typeof installApi>;
  let pinia: ReturnType<typeof createPinia>;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    state = { list: [] };
    api = installApi(state);
  });

  const render = async (options: { compose?: boolean | 'course'; id?: string } = {}) => {
    const store = useRequirementsStore();
    await store.open(options);
    const wrapper = await mountView(RequirementsView);
    return { wrapper, store };
  };

  test('我想学… opens the course form with picked defaults and sends them with the goal', async () => {
    const { wrapper, store } = await render();
    await wrapper.get('.req-empty [data-action="learn"]').trigger('click');
    expect(wrapper.find('[data-field="level"]').exists()).toBe(true);
    await wrapper.find('[data-field="toolchain"] input[value="c"]').setValue(true);
    await wrapper.find('[data-field="weeklyHours"] input[value="8"]').trigger('click');
    await wrapper.find('#reqText').setValue('想学操作系统的进程调度');
    await wrapper.find('form[data-pane="new"]').trigger('submit');
    await flushPromises();
    expect(api.requirements.create).toHaveBeenCalledWith({
      title: '',
      text: '想学操作系统的进程调度',
      course: { level: 'basic', target: 'implement', environment: '', weeklyHours: 8, toolchain: 'c' },
    });
    store.stopWatching();
    wrapper.unmount();
  });

  test('answering: Tutor’s pick is preselected; choosing a new pack asks for a draft', async () => {
    state.list = [
      requirement({ kind: 'course', status: 'answering', summary: MARKUP, questions: [{ text: '多核？', answer: '' }], course: courseInterview() }),
    ];
    const { wrapper, store } = await render();
    expect(wrapper.find('img').exists()).toBe(false);
    expect(wrapper.findAll('.req-stepper li').map((step) => step.text())).toEqual(['访谈', '选课程包', '规划路径', '确认路径']);
    expect((wrapper.get('[data-course="os"] input').element as HTMLInputElement).checked).toBe(true);
    await wrapper.find('#courseAnswer0').setValue('先不用');
    await wrapper.get('[data-action="course-plan"]').trigger('click');
    await flushPromises();
    expect(api.requirements.plan).toHaveBeenLastCalledWith('r1', ['先不用'], { course: 'os' });
    store.stopWatching();
    wrapper.unmount();

    state.list = [
      requirement({ kind: 'course', status: 'answering', course: courseInterview({ pick: { course: null, reason: '都不讲编译。', options: [] } }) }),
    ];
    const second = await render();
    expect((second.wrapper.get('[data-course="draft"] input').element as HTMLInputElement).checked).toBe(true);
    await second.wrapper.get('[data-action="course-plan"]').trigger('click');
    await flushPromises();
    expect(api.requirements.plan).toHaveBeenLastCalledWith('r1', [], { draft: true });
    second.store.stopWatching();
    second.wrapper.unmount();
  });

  test('reviewing a path: marks and moves are saved, a move before a prerequisite is disabled, then confirm', async () => {
    state.list = [requirement({ kind: 'course', status: 'reviewing', course: coursePathInterview() })];
    const { wrapper } = await render();
    const items = wrapper.findAll('.course-path-item');
    expect(items.map((item) => item.attributes('data-concept'))).toEqual(['process-state', 'fcfs', 'round-robin']);
    expect(items[0].attributes('data-status')).toBe('known');
    // fcfs needs process-state, so it cannot move above it.
    expect(items[1].get('[aria-label="上移先来先服务"]').attributes('disabled')).toBeDefined();
    await items[2].find('input[value="skipped"]').setValue(true);
    await flushPromises();
    expect(api.requirements.coursePath).toHaveBeenCalledWith('r1', [
      { conceptId: 'process-state', status: 'known' },
      { conceptId: 'fcfs', status: 'planned' },
      { conceptId: 'round-robin', status: 'skipped' },
    ]);
    await wrapper.get('[data-action="confirm-path"]').trigger('click');
    await flushPromises();
    expect(api.requirements.publish).toHaveBeenCalledWith('r1');
    wrapper.unmount();
  });

  test('a draft is shown in full, edited and saved, then confirmed at the saved content', async () => {
    const pack = { ...OS_COURSE, id: 'lexing', title: '编译原理：词法分析', version: '0.1.0' };
    state.list = [
      requirement({ kind: 'course', status: 'reviewing', course: courseInterview({ choice: { draft: true }, draft: { pack, contentHash: 'h' } }) }),
    ];
    const { wrapper, store } = await render();
    expect(wrapper.find('[data-draft="lexing"] h3').text()).toBe('编译原理：词法分析');
    expect(wrapper.find('.course-fields').exists()).toBe(true);
    await wrapper.get('[data-action="edit-draft"]').trigger('click');
    await wrapper.get('form.course-editor').trigger('submit');
    await flushPromises();
    expect(api.requirements.courseSaveDraft).toHaveBeenCalledWith('r1', expect.objectContaining({ id: 'lexing' }));
    expect(wrapper.find('[data-saved="lexing"]').exists()).toBe(true);
    await wrapper.get('[data-action="confirm-draft"]').trigger('click');
    await flushPromises();
    expect(api.requirements.courseConfirmDraft).toHaveBeenCalledWith('r1', 'saved-hash');
    expect(api.requirements.plan).toHaveBeenLastCalledWith('r1', undefined);
    store.stopWatching();
    wrapper.unmount();
  });

  test('a confirmed path shows the first lab’s estimate before anything runs, then its progress, then only its title and counts', async () => {
    state.list = [requirement({ kind: 'course', status: 'published', course: coursePathInterview() })];
    const { wrapper, store } = await render();
    expect(wrapper.find('[data-action="generate-lab"]').exists()).toBe(false);
    await wrapper.get('[data-action="estimate-lab"]').trigger('click');
    await flushPromises();
    expect(api.requirements.labEstimate).toHaveBeenCalledWith('r1', undefined);
    expect(api.requirements.labGenerate).not.toHaveBeenCalled();
    expect(wrapper.get('[data-field="estimate"]').text()).toContain('约 $0.42–$1.35，含生成后的自验证');
    expect(wrapper.get('[data-field="estimate"]').text()).toContain('调用 4 次模型，要修改时最多 10 次');
    expect(wrapper.get('[data-section="first-lab"]').text()).toContain('时间片轮转');

    state.list = [
      requirement({ kind: 'course', status: 'published', course: { ...coursePathInterview(), lab: labGeneration({ status: 'running', phase: 'spec' }) } }),
    ];
    await wrapper.get('[data-action="generate-lab"]').trigger('click');
    await flushPromises();
    expect(api.requirements.labGenerate).toHaveBeenCalledWith('r1', undefined);
    expect(wrapper.get('[data-section="first-lab"]').text()).toContain('正在写题面和测试');
    await wrapper.get('[data-action="cancel-lab"]').trigger('click');
    await flushPromises();
    expect(api.requirements.cancel).toHaveBeenCalledWith('r1');
    store.stopWatching();
    wrapper.unmount();
  });

  test('a missing tool shows its install command and keeps generate disabled until a recheck finds it', async () => {
    const missing: requirementTypes.LabEstimate = {
      ...LAB_ESTIMATE,
      toolchain: {
        ...LAB_ESTIMATE.toolchain,
        ready: false,
        tools: [LAB_ESTIMATE.toolchain.tools[0]!, { command: 'make', version: null, install: 'xcode-select --install' }],
      },
    };
    api.requirements.labEstimate.mockResolvedValueOnce({ ok: true, data: missing });
    state.list = [requirement({ kind: 'course', status: 'published', course: coursePathInterview() })];
    const { wrapper, store } = await render();
    await wrapper.get('[data-action="estimate-lab"]').trigger('click');
    await flushPromises();
    const makeRow = wrapper.findAll('[data-field="toolchain-check"] li')[1]!;
    expect(makeRow.text()).toContain('未找到');
    expect(makeRow.findAll('code').map((code) => code.text())).toEqual(['make', 'xcode-select --install']);
    expect(wrapper.get('[data-action="generate-lab"]').attributes('disabled')).toBeDefined();

    await wrapper.get('[data-action="recheck-toolchain"]').trigger('click');
    await flushPromises();
    expect(api.requirements.labEstimate).toHaveBeenCalledTimes(2);
    expect(wrapper.get('[data-action="generate-lab"]').attributes('disabled')).toBeUndefined();
    expect(wrapper.find('[data-action="recheck-toolchain"]').exists()).toBe(false);
    store.stopWatching();
    wrapper.unmount();
  });

  test('a passed first lab is placed in a picked folder and switches to that repository', async () => {
    state.list = withLab(labGeneration({ stage: 1, placed: false }));
    const { wrapper, store } = await render();
    await wrapper.get('[data-action="place-lab"]').trigger('click');
    await flushPromises();
    expect(api.workspace.pickRoot).toHaveBeenCalled();
    expect(api.requirements.labPlace).toHaveBeenCalledWith('r1', '/Users/me/sched-lab');
    expect(api.repositories.list).toHaveBeenCalled();
    expect(api.tasks.list).toHaveBeenCalled();
    store.stopWatching();
    wrapper.unmount();
  });

  // ========== Self-check ==========
  const round = (overrides: Partial<requirementTypes.LabVerifyRound> = {}): requirementTypes.LabVerifyRound => ({
    round: 1,
    checks: { reference: true, starter: true, mutants: true, consistency: true },
    mutants: { killed: 5, publicKilled: 3, total: 5 },
    issues: 0,
    repaired: false,
    ...overrides,
  });
  const failedRound = (number: number, repaired: boolean) =>
    round({
      round: number,
      checks: { reference: true, starter: true, mutants: false, consistency: false },
      mutants: { killed: 3, publicKilled: 1, total: 5 },
      issues: 2,
      repaired,
    });
  const withLab = (lab: requirementTypes.LabGeneration) => [requirement({ kind: 'course', status: 'published', course: { ...coursePathInterview(), lab } })];

  test('while the self-check repairs, the round and what it found are shown, never the details', async () => {
    const verify = { round: 1, maxRounds: 3, rounds: [failedRound(1, false)], costUsd: 0.2 };
    state.list = withLab(labGeneration({ status: 'running', phase: 'repair', verify }));
    const { wrapper, store } = await render();
    const text = wrapper.get('[data-field="verify-progress"]').text();
    expect(text).toContain('自验证第 1 / 3 轮');
    expect(text).toContain('变异检测：抓住 3/5，公开测试 1/5');
    expect(text).toContain('一致性：2 处问题');
    expect(wrapper.get('[data-section="first-lab"]').text()).toContain('自验证没通过，正在按报告修改');
    store.stopWatching();
    wrapper.unmount();
  });

  test('a lab that passed shows in which round and what the self-check cost', async () => {
    state.list = withLab(labGeneration({ verify: { round: 2, maxRounds: 3, rounds: [failedRound(1, true), round({ round: 2 })], costUsd: 0.5 } }));
    const { wrapper, store } = await render();
    expect(wrapper.get('[data-field="verify-result"]').text()).toContain('自验证第 2 轮通过');
    expect(wrapper.get('[data-field="verify-result"]').text()).toContain('$0.50');
    store.stopWatching();
    wrapper.unmount();
  });

  test('a lab that needs review shows the last round and offers another concept on the path; the pack example is not available yet', async () => {
    const verify = { round: 3, maxRounds: 3, rounds: [failedRound(1, true), failedRound(2, true), failedRound(3, false)], costUsd: 1.1 };
    state.list = withLab(labGeneration({ status: 'needs_review', verify, concepts: ['fcfs'] }));
    const { wrapper, store } = await render();
    const section = wrapper.get('[data-section="first-lab"]');
    expect(section.get('[role="alert"]').text()).toContain('「时间片轮转调度」自验证 3 轮都没通过');
    expect(section.get('[data-field="verify-result"]').text()).toContain('参考解：通过');
    expect(section.get('[data-field="verify-result"]').text()).toContain('变异检测：抓住 3/5');
    expect(section.get('[data-action="pack-example"]').attributes('disabled')).toBeDefined();
    expect(section.get('[data-action="other-concept"]').attributes('disabled')).toBeDefined();
    // Only the other concept still to learn is offered.
    await section.get('[data-field="other-concept"] .el-select__wrapper').trigger('click');
    await flushPromises();
    const options = [...document.querySelectorAll('.el-select-dropdown__item')].map((item) => item.textContent?.trim());
    expect(options).toEqual(['时间片轮转']);
    (document.querySelector('.el-select-dropdown__item') as HTMLElement).click();
    await flushPromises();
    await section.get('[data-action="other-concept"]').trigger('click');
    await flushPromises();
    expect(api.requirements.labEstimate).toHaveBeenCalledWith('r1', 'round-robin');
    // The estimate replaces the choice; confirming generates for that concept.
    state.list = withLab(labGeneration({ status: 'running', phase: 'spec', concepts: ['round-robin'] }));
    await wrapper.get('[data-action="generate-lab"]').trigger('click');
    await flushPromises();
    expect(api.requirements.labGenerate).toHaveBeenCalledWith('r1', 'round-robin');
    store.stopWatching();
    wrapper.unmount();
  });
});
