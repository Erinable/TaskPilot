// @vitest-environment happy-dom
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount } from '@vue/test-utils';

import SideBar from '../../../src/renderer/src/components/SideBar.vue';
import { SIDEBAR_STORAGE_KEY, useAppStore } from '../../../src/renderer/src/stores/app.ts';
import { useTasksStore } from '../../../src/renderer/src/stores/tasks.ts';
import { installApi } from '../requirements_fakes.ts';
import { taskView } from '../execution_fakes.ts';

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
    const team = wrapper.findAll('.nav-item').find((node) => node.text().includes('团队概览'))!;
    for (const view of ['team', 'activity', 'costs'] as const) {
      useAppStore().view = view;
      await wrapper.vm.$nextTick();
      expect(team.classes()).toContain('active');
    }
  });
});
