// @vitest-environment happy-dom
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';

import QueueView from '../../../src/renderer/src/views/QueueView.vue';
import { useTasksStore } from '../../../src/renderer/src/stores/tasks.ts';
import { useRequirementsStore } from '../../../src/renderer/src/stores/requirements.ts';
import { useAppStore } from '../../../src/renderer/src/stores/app.ts';
import { installApi, requirement } from '../requirements_fakes.ts';
import type * as ipc from '../../../src/shared/ipc_types.ts';

vi.mock('../../../src/renderer/src/lib/feedback.ts', () => {
  const showToast = vi.fn();
  // announceAgent adds a system notification only in the background; tests see the toast.
  return { showToast, announceAgent: (...args: unknown[]) => showToast(...args), confirmAction: vi.fn(async () => true), openDialogs: { value: 0 } };
});

describe('QueueView', () => {
  let pinia: ReturnType<typeof createPinia>;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    installApi({ list: [] });
  });

  const render = () => mount(QueueView, { global: { plugins: [pinia, ElementPlus] } });

  test('an empty queue guides the user to the requirement center', async () => {
    const requirements = useRequirementsStore();
    const open = vi.spyOn(requirements, 'open').mockResolvedValue();
    const wrapper = render();
    const empty = wrapper.find('.task-list [data-empty="queue"]');
    expect(empty.exists()).toBe(true);
    expect(empty.find('h2').text()).toBe('还没有工作包');
    expect(empty.find('p').text()).toBe('在需求中心描述需求，Product Lead 拆解并经你确认后，工作包会出现在这里。');
    expect(wrapper.findAll('.task-item')).toHaveLength(0);

    await empty.find('button').trigger('click');
    expect(open).toHaveBeenCalledWith({ compose: true });
  });

  test('the empty state goes away once packages are published', async () => {
    useTasksStore().tasks = [
      {
        id: 'r1-wp1',
        title: '登录接口',
        description: '实现邮箱登录',
        status: 'pending',
        statusLabel: '待领取',
        priority: 'high',
        tags: ['auth'],
        estimate: '预计 1 小时',
        icon: 'key',
      } as ipc.TaskView,
    ];
    const wrapper = render();
    await flushPromises();
    expect(wrapper.find('[data-empty="queue"]').exists()).toBe(false);
    expect(wrapper.findAll('.task-item')).toHaveLength(1);
  });

  test('metrics, presence and the feed come from the activity overview', async () => {
    useAppStore().activity = {
      recent: [
        {
          kind: 'package_transition',
          packageId: 'p1',
          title: '登录接口',
          transition: 'review_passed',
          actor: 'agent',
          from: 'in_review',
          to: 'accepting',
          at: new Date().toISOString(),
        },
        { kind: 'requirement_created', requirementId: 'r1', title: '<img src=x onerror=alert(1)>', at: new Date(Date.now() - 5 * 60_000).toISOString() },
      ],
      metrics: { doneThisWeek: 5, donePreviousWeek: 4, averageHours: 2.44, averageHoursPrevious: 2.4 },
      team: { available: true, busy: ['qa'] },
      timeZone: 'Asia/Shanghai',
    };
    const wrapper = render();
    await flushPromises();
    const metrics = wrapper.findAll('.metric-card strong').map((node) => node.text());
    expect(metrics.slice(1)).toEqual(['5', '2.4h']);
    expect(wrapper.findAll('.metric-trend').map((node) => node.text())).toEqual(['+25%', '较上周稳定']);
    expect(wrapper.find('.team-presence').text()).toBe('1 个 AI 成员正在工作');
    const items = wrapper.findAll('.activity-item');
    expect(items[0].find('p').text()).toBe('QA Partner 审查通过，等你验收');
    expect(items[0].find('time').text()).toBe('刚刚');
    // Titles are model or user text: shown as text, never markup.
    expect(items[1].find('small').text()).toBe('<img src=x onerror=alert(1)>');
    expect(wrapper.find('.activity-list img').exists()).toBe(false);
  });

  test('before the first overview the metrics show placeholders and the feed stays empty', () => {
    const wrapper = render();
    expect(
      wrapper
        .findAll('.metric-card strong')
        .map((node) => node.text())
        .slice(1),
    ).toEqual(['–', '–']);
    expect(wrapper.find('.team-presence').exists()).toBe(false);
    expect(wrapper.find('.activity-list .empty-hint').exists()).toBe(false);
  });

  test('done packages are hidden by default and the footer shows them all', async () => {
    const base = { description: '', statusLabel: '', tags: [] as string[], estimate: '', icon: 'key', steps: [], completedSteps: [] };
    useTasksStore().tasks = [
      { ...base, id: 'low', title: '低', status: 'pending', priority: 'low' },
      { ...base, id: 'done', title: '完成', status: 'done', priority: 'high' },
      { ...base, id: 'high', title: '高', status: 'in_progress', priority: 'high' },
    ] as unknown as ipc.TaskView[];
    const wrapper = mount(QueueView, { global: { plugins: [pinia, ElementPlus] } });
    await flushPromises();
    expect(wrapper.findAll('.task-title').map((node) => node.text())).toEqual(['高', '低']);
    expect(wrapper.find('.filter-button').text()).toBe('未完成');
    const footer = wrapper.find('.view-all-button');
    expect(footer.text()).toBe('查看全部 3 个工作包');
    await footer.trigger('click');
    expect(wrapper.findAll('.task-title').map((node) => node.text())).toEqual(['完成', '高', '低']);
    expect(wrapper.find('.filter-button').text()).toBe('全部状态');
  });

  test('started packages show step progress; pending ones do not', async () => {
    const base = { description: '', statusLabel: '', tags: [] as string[], estimate: '', icon: 'key', priority: 'high', steps: ['a', 'b', 'c', 'd'] };
    useTasksStore().tasks = [
      { ...base, id: 'run', title: '执行中', status: 'in_progress', completedSteps: [0, 2] },
      { ...base, id: 'new', title: '待执行', status: 'pending', completedSteps: [] },
    ] as unknown as ipc.TaskView[];
    const wrapper = render();
    await flushPromises();
    const items = wrapper.findAll('.task-item');
    expect(items[0].find('[data-progress]').text()).toBe('2 / 4 步');
    expect(items[0].find('.progress-fill').attributes('style')).toContain('width: 50%');
    expect(items[1].find('[data-progress]').exists()).toBe(false);
  });

  test('an empty filter offers to show every package', async () => {
    const base = { description: '', statusLabel: '', tags: [] as string[], estimate: '', icon: 'key', priority: 'high', steps: [], completedSteps: [] };
    useTasksStore().tasks = [{ ...base, id: 'done', title: '完成', status: 'done' }] as unknown as ipc.TaskView[];
    const wrapper = render();
    await flushPromises();
    await wrapper.find('[data-empty="filter"] .empty-action').trigger('click');
    expect(wrapper.findAll('.task-title').map((node) => node.text())).toEqual(['完成']);
  });

  test('a new user sees the getting-started checklist with the next step highlighted', async () => {
    const wrapper = render();
    await flushPromises();
    const checklist = wrapper.get('[data-onboarding]');
    expect(checklist.get('h2').text()).toBe('开始使用 TaskPilot');
    // The fake CLI is available; no repository is set up yet.
    expect(checklist.get('[data-step="cli"]').classes()).toContain('done');
    expect(checklist.get('[data-step="repository"]').classes()).toContain('next');
    expect(checklist.get('[data-step="checks"] button').attributes('disabled')).toBeDefined();
  });

  test('a fully set-up user never sees the checklist', async () => {
    const api = installApi({ list: [requirement()] });
    api.workspace.info.mockImplementation(
      () => Promise.resolve({ ok: true, data: { configured: true, root: '/r', commit: 'a', branch: 'main', dirty: false, changedFiles: 0 } }) as never,
    );
    api.workspace.get.mockImplementation(() => Promise.resolve({ ok: true, data: { lines: { test: 'npm test' } } }) as never);
    await useAppStore().refreshWorkspaceStatus();
    await useRequirementsStore().refreshList();
    const wrapper = render();
    await flushPromises();
    expect(wrapper.find('[data-onboarding]').exists()).toBe(false);
  });
});
