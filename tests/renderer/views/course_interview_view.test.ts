// @vitest-environment happy-dom
// The course interview in the requirement center: the "我想学…" form, picking
// a pack, adjusting the path and the drafted pack.
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';

import RequirementsView from '../../../src/renderer/src/views/RequirementsView.vue';
import { useRequirementsStore } from '../../../src/renderer/src/stores/requirements.ts';
import { courseInterview, coursePathInterview, installApi, requirement } from '../requirements_fakes.ts';
import { OS_COURSE } from '../../fixtures/builtin_courses.ts';

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
    const wrapper = mount(RequirementsView, { global: { plugins: [ElementPlus, pinia] }, attachTo: document.body });
    await flushPromises();
    return { wrapper, store };
  };

  test('我想学… opens the course form with picked defaults and sends them with the goal', async () => {
    const { wrapper, store } = await render();
    await wrapper.get('.req-empty [data-action="learn"]').trigger('click');
    expect(wrapper.find('.req-header h2').text()).toBe('你想学什么');
    expect(wrapper.find('[data-field="level"]').exists()).toBe(true);
    await wrapper.find('[data-field="weeklyHours"] input[value="8"]').setValue(true);
    await wrapper.find('#reqText').setValue('想学操作系统的进程调度');
    await wrapper.find('form[data-pane="new"]').trigger('submit');
    await flushPromises();
    expect(api.requirements.create).toHaveBeenCalledWith({
      title: '',
      text: '想学操作系统的进程调度',
      course: { level: 'basic', target: 'implement', environment: 'macOS，本机 C 编译器', weeklyHours: 8 },
    });
    store.stopPolling();
    wrapper.unmount();
  });

  test('the project form is unchanged: no course fields, no course argument', async () => {
    const { wrapper, store } = await render({ compose: true });
    expect(wrapper.find('[data-field="level"]').exists()).toBe(false);
    await wrapper.find('#reqText').setValue('邮箱登录');
    await wrapper.find('form[data-pane="new"]').trigger('submit');
    await flushPromises();
    expect(api.requirements.create).toHaveBeenCalledWith({ title: '', text: '邮箱登录' });
    store.stopPolling();
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
    store.stopPolling();
    wrapper.unmount();

    state.list = [
      requirement({ kind: 'course', status: 'answering', course: courseInterview({ pick: { course: null, reason: '都不讲编译。', options: [] } }) }),
    ];
    const second = await render();
    expect((second.wrapper.get('[data-course="draft"] input').element as HTMLInputElement).checked).toBe(true);
    expect(second.wrapper.get('[data-action="course-plan"]').text()).toBe('起草课程包');
    await second.wrapper.get('[data-action="course-plan"]').trigger('click');
    await flushPromises();
    expect(api.requirements.plan).toHaveBeenLastCalledWith('r1', [], { draft: true });
    second.store.stopPolling();
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
    store.stopPolling();
    wrapper.unmount();
  });
});
