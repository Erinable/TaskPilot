// @vitest-environment happy-dom
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount } from '@vue/test-utils';

import SideBar from '../../../src/renderer/src/components/SideBar.vue';
import { SIDEBAR_STORAGE_KEY, useAppStore } from '../../../src/renderer/src/stores/app.ts';
import { useTasksStore } from '../../../src/renderer/src/stores/tasks.ts';
import { installApi } from '../requirements_fakes.ts';
import { taskView } from '../execution_fakes.ts';
import type { AgentId } from '../../../src/shared/agent_runtime.ts';
import type { ActivityOverview, TeamStatus } from '../../../src/shared/ipc/activity.ts';

vi.mock('../../../src/renderer/src/lib/feedback.ts', () => ({
  showToast: vi.fn(),
  announceAgent: vi.fn(),
  confirmAction: vi.fn(async () => true),
  openDialogs: { value: 0 },
}));

describe('SideBar', () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
    installApi({ list: [] });
  });

  test('collapses to an icon rail and remembers it on this machine', async () => {
    const wrapper = mount(SideBar);
    const toggle = wrapper.find('button.sidebar-toggle');
    expect(wrapper.classes()).not.toContain('collapsed');
    expect(toggle.attributes('aria-expanded')).toBe('true');
    expect(toggle.text()).toBe('收起侧栏');

    await toggle.trigger('click');

    expect(wrapper.classes()).toContain('collapsed');
    expect(toggle.attributes('aria-expanded')).toBe('false');
    expect(toggle.text()).toBe('展开侧栏');
    expect(localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe('true');

    // A fresh app start reads the saved choice.
    setActivePinia(createPinia());
    expect(mount(SideBar).classes()).toContain('collapsed');
  });

  test('collapsed items keep their names for tooltips and screen readers', async () => {
    useTasksStore().tasks = [taskView({ status: 'pending' })];
    useAppStore().toggleSidebar();
    const wrapper = mount(SideBar);
    await wrapper.vm.$nextTick();

    const queue = wrapper.find('nav button.nav-item');
    expect(queue.text()).toContain('工作队列');
    expect(queue.attributes('title')).toMatch(/^工作队列（\d+ 个待办）$/);
    for (const item of wrapper.findAll('nav button.nav-item')) expect(item.attributes('title')).toBeTruthy();
  });

  test('expanded items carry no tooltip, since the label is visible', () => {
    const wrapper = mount(SideBar);
    for (const item of wrapper.findAll('nav button.nav-item')) expect(item.attributes('title')).toBeUndefined();
  });

  test('an unreadable stored value opens expanded', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(useAppStore().sidebarCollapsed).toBe(false);
    vi.restoreAllMocks();
  });
  test('members, activity and cost share one entry, which stays active on each tab', async () => {
    const wrapper = mount(SideBar);
    const labels = wrapper.findAll('.nav-item .nav-label').map((node) => node.text());
    expect(labels).not.toContain('活动记录');
    expect(labels).not.toContain('成本');
    const team = wrapper.find('button.team-entry');
    expect(team.text()).toBe('AI 团队');
    for (const view of ['team', 'activity', 'costs'] as const) {
      useAppStore().view = view;
      await wrapper.vm.$nextTick();
      expect(team.classes()).toContain('active');
    }
  });

  test('the team is one entry; a status line appears only while someone works', async () => {
    const app = useAppStore();
    const team = (busy: AgentId[], work: TeamStatus['work'] = []): TeamStatus => ({
      available: true,
      availableByAgent: { 'product-lead': true, architect: true, qa: true, 'release-manager': true, 'env-steward': true, tutor: true, 'coding-agent': false },
      busy,
      work,
    });
    app.activity = { team: team([]) } as ActivityOverview;
    const wrapper = mount(SideBar);
    expect(wrapper.findAll('button.team-member')).toHaveLength(0);
    expect(wrapper.findAll('.team-stack-avatar')).toHaveLength(7);
    expect(wrapper.find('.team-stack-avatar.code').classes()).toContain('offline');
    expect(wrapper.find('.team-entry-work').exists()).toBe(false);
    expect(wrapper.find('button.team-entry').attributes('aria-label')).toBe('AI 团队：6 个 AI 成员在线');

    app.activity = { team: team(['architect'], [{ agent: 'architect', kind: 'adjudication', label: 'x' }]) } as ActivityOverview;
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.team-entry-work').text()).toBe('Architect 正在裁决偏差…');
    expect(wrapper.find('.team-stack-avatar.arch').classes()).toContain('busy');
    expect(wrapper.findAll('.team-stack .presence.busy')).toHaveLength(1);

    app.toggleSidebar();
    await wrapper.vm.$nextTick();
    const entry = wrapper.find('button.team-entry');
    expect(entry.attributes('title')).toBe('AI 团队：Architect 正在裁决偏差…');
    expect(entry.attributes('aria-label')).toBe('AI 团队：Architect 正在裁决偏差…');
  });
});
