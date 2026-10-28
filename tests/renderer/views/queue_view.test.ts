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
import { taskView, testStepWorkspace } from '../execution_fakes.ts';
import { ok } from '../ipc_fakes.ts';
import type * as packageTypes from '../../../src/shared/ipc/packages.ts';

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
    // These tests cover the list layout; the board has its own tests.
    localStorage.setItem('taskpilot.queueLayout', 'list');
  });

  const render = () => mount(QueueView, { global: { plugins: [pinia, ElementPlus] } });

  test('an empty queue guides the user to the requirement center', async () => {
    const requirements = useRequirementsStore();
    const open = vi.spyOn(requirements, 'open').mockResolvedValue();
    const wrapper = render();
    const empty = wrapper.find('.task-list [data-empty="queue"]');
    expect(empty.exists()).toBe(true);
    expect(wrapper.findAll('.task-item')).toHaveLength(0);

    await empty.find('button').trigger('click');
    expect(open).toHaveBeenCalledWith({ compose: true });
  });

  test('the empty state goes away once packages are published', async () => {
    useTasksStore().tasks = [taskView({ status: 'pending', title: '登录接口' })];
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
      team: {
        available: true,
        availableByAgent: { 'product-lead': true, architect: true, qa: true, 'release-manager': true, 'env-steward': true, tutor: true, 'coding-agent': false },
        busy: ['qa'],
        work: [{ agent: 'qa', kind: 'review', label: '登录接口' }],
      },
      costs: {
        byAgent: { 'product-lead': 0, architect: 0, qa: 0, 'release-manager': 0, 'env-steward': 0, tutor: 0, 'coding-agent': 0 },
        since: null,
        partial: true,
      },
      teamRecent: { 'product-lead': [], architect: [], qa: [], 'release-manager': [], 'env-steward': [], tutor: [], 'coding-agent': [] },
      timeZone: 'Asia/Shanghai',
    };
    const wrapper = render();
    await flushPromises();
    const metrics = wrapper.findAll('.metric-card strong').map((node) => node.text());
    // Pending count, done this week, estimate accuracy (no finished package), average time.
    expect(metrics.slice(1)).toEqual(['5', '–', '2.4h']);
    expect(wrapper.findAll('.metric-trend').map((node) => node.text())).toEqual(['+25%', '完成第一个工作包后统计', '较上周稳定']);
    expect(wrapper.find('.team-presence').text()).toBe('1 个 AI 成员正在工作');
    const items = wrapper.findAll('.activity-item');
    expect(items[0].find('p').text()).toBe('QA Partner 审查通过，等你验收');
    expect(items[0].find('time').text()).toBe('刚刚');
    // Titles are model or user text: shown as text, never markup.
    expect(items[1].find('small').text()).toBe('<img src=x onerror=alert(1)>');
    expect(wrapper.find('.activity-list img').exists()).toBe(false);
  });

  test('before anything is finished the metrics are hidden and the feed stays empty', () => {
    const wrapper = render();
    // Weekly numbers would all read "–" on day one.
    expect(wrapper.find('.metrics-row').exists()).toBe(false);
    expect(wrapper.find('.team-presence').exists()).toBe(false);
    expect(wrapper.find('.activity-list .empty-hint').exists()).toBe(false);
  });

  test('done packages are hidden by default and the footer shows them all', async () => {
    const base = { description: '', statusLabel: '', tags: [] as string[], estimate: '', icon: 'key', steps: [], completedSteps: [] };
    useTasksStore().tasks = [
      { ...base, id: 'low', title: '低', status: 'pending', priority: 'low' },
      { ...base, id: 'done', title: '完成', status: 'done', priority: 'high' },
      { ...base, id: 'high', title: '高', status: 'in_progress', priority: 'high' },
    ] as unknown as packageTypes.TaskView[];
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
    ] as unknown as packageTypes.TaskView[];
    const wrapper = render();
    await flushPromises();
    const items = wrapper.findAll('.task-item');
    expect(items[0].find('[data-progress]').text()).toBe('2 / 4 步');
    expect(items[0].find('.progress-fill').attributes('style')).toContain('width: 50%');
    expect(items[1].find('[data-progress]').exists()).toBe(false);
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
    api.workspace.info.mockImplementation(() => ok({ configured: true, root: '/r', commit: 'a', branch: 'main', dirty: false, changedFiles: 0 }));
    api.workspace.get.mockImplementation(() => ok(testStepWorkspace('/r')));
    await useAppStore().refreshWorkspaceStatus();
    await useRequirementsStore().refreshList();
    const wrapper = render();
    await flushPromises();
    expect(wrapper.find('[data-onboarding]').exists()).toBe(false);
  });
});

describe('QueueView board', () => {
  let pinia: ReturnType<typeof createPinia>;
  const pkg = (overrides: Partial<packageTypes.TaskView>) =>
    ({
      title: '包',
      description: 'd',
      statusLabel: 's',
      priority: 'medium',
      tags: [],
      estimate: '预计 1 小时',
      icon: 'key',
      steps: ['a'],
      completedSteps: [],
      dependencies: [],
      humanTransitions: [],
      claimedAt: null,
      completedAt: null,
      review: null,
      codingRun: null,
      ...overrides,
    }) as packageTypes.TaskView;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    installApi({ list: [] });
    localStorage.removeItem('taskpilot.queueLayout');
  });

  const render = () => mount(QueueView, { global: { plugins: [pinia, ElementPlus] } });

  test('shows the board by default with a card per package in its stage, and remembers the list choice', async () => {
    useTasksStore().tasks = [
      pkg({ id: 'a', title: '实现用例', status: 'in_progress' }),
      pkg({
        id: 'b',
        title: '接入路由',
        status: 'pending',
        dependencies: [{ id: 'a', title: '实现用例', status: 'in_progress', waived: false, blocking: true }],
      }),
      pkg({ id: 'c', title: '写文档', status: 'pending', humanTransitions: ['claim'] }),
    ];
    const wrapper = render();
    await flushPromises();
    const column = (label: string) => wrapper.findAll('.board-column').find((node) => node.find('h3').text() === label);
    expect(column('待执行')?.findAll('.board-card')).toHaveLength(2);
    expect(column('执行中')?.find('.board-card').text()).toContain('继续');
    const waiting = wrapper.find('[data-package="b"]');
    expect(waiting.text()).toContain('等待：实现用例');
    expect(waiting.find('.board-card-action button').exists()).toBe(false);
    expect(wrapper.find('[data-package="c"] .board-card-action button').text()).toBe('开始执行');

    await wrapper.findAll('.layout-toggle button')[1].trigger('click');
    expect(wrapper.find('.board').exists()).toBe(false);
    expect(wrapper.findAll('.task-item')).toHaveLength(3);
    expect(localStorage.getItem('taskpilot.queueLayout')).toBe('list');
  });

  test('suggests one package at a time when several are in progress', async () => {
    useTasksStore().tasks = [taskView({ id: 'a', status: 'in_progress' }), taskView({ id: 'b', status: 'in_progress' })];
    const wrapper = render();
    await flushPromises();
    expect(wrapper.find('.board-hint').text()).toContain('同时在做 2 个');
  });
});
