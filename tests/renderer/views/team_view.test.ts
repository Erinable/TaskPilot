// @vitest-environment happy-dom
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';

import TeamView from '../../../src/renderer/src/views/TeamView.vue';
import SideBar from '../../../src/renderer/src/components/SideBar.vue';
import { useAppStore } from '../../../src/renderer/src/stores/app.ts';
import { useSettingsStore } from '../../../src/renderer/src/stores/settings.ts';
import { installApi } from '../requirements_fakes.ts';
import type * as ipc from '../../../src/shared/ipc_types.ts';

vi.mock('../../../src/renderer/src/lib/feedback.ts', () => ({
  showToast: vi.fn(),
  announceAgent: vi.fn(),
  confirmAction: vi.fn(async () => true),
  openDialogs: { value: 0 },
}));

const MARKUP = '<img src=x onerror=alert(1)>';

const REVIEW: ipc.ActivityRecord = {
  kind: 'package_transition',
  packageId: 'p1',
  title: '登录接口',
  transition: 'review_passed',
  actor: 'agent',
  from: 'in_review',
  to: 'accepting',
  at: new Date().toISOString(),
};

const overview = (overrides: Partial<ipc.ActivityOverview> = {}): ipc.ActivityOverview => ({
  // The shared feed holds only the human's step; QA's review is older than its 20 newest.
  recent: [{ kind: 'requirement_created', requirementId: 'r1', title: '邮箱登录', at: new Date().toISOString() }],
  metrics: { doneThisWeek: 0, donePreviousWeek: 0, averageHours: null, averageHoursPrevious: null },
  team: { available: true, busy: ['qa'], work: [{ agent: 'qa', kind: 'review', label: MARKUP }] },
  costs: { byAgent: { 'product-lead': 0.034, architect: 0, qa: 1.5, 'release-manager': 0 }, since: '2026-10-07T02:00:00.000Z', partial: true },
  teamRecent: { 'product-lead': [], architect: [], qa: [REVIEW], 'release-manager': [] },
  timeZone: 'Asia/Shanghai',
  ...overrides,
});

const card = (wrapper: VueWrapper, agent: string) => wrapper.find(`#team-${agent}`);

describe('TeamView', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    installApi({ list: [] });
    Object.assign(window.taskpilot, { businessTimeZone: 'Asia/Shanghai' });
  });

  test('one card per member with role, current work, weekly spend and recent events', () => {
    useAppStore().activity = overview();
    const wrapper = mount(TeamView);
    expect(wrapper.findAll('.team-card')).toHaveLength(4);

    const qa = card(wrapper, 'qa');
    expect(qa.find('h2').text()).toBe('QA Partner');
    expect(qa.find('.presence-text').text()).toBe('工作中');
    expect(qa.find('.team-role').text()).toContain('验收条件');
    // Package titles are model text: shown as text, never markup.
    expect(qa.find('.team-work').text()).toBe(`正在审查工作包「${MARKUP}」`);
    expect(qa.find('.team-work img').exists()).toBe(false);
    expect(qa.find('.team-cost').text()).toBe('$1.50');
    expect(qa.find('.team-facts small').text()).toBe('从 10 月 7 日开始统计');
    expect(qa.findAll('.team-recent li').map((item) => item.find('span').text())).toEqual(['审查通过，等你验收：登录接口']);

    const pm = card(wrapper, 'product-lead');
    expect(pm.find('.team-cost').text()).toBe('$0.034');
    expect(pm.find('.team-facts dd').text()).toBe('空闲，等待下一项任务');
    expect(pm.find('.team-recent').text()).toContain('最近没有动态');
  });

  test('a full recorded week drops the partial note', () => {
    useAppStore().activity = overview({ costs: { ...overview().costs, partial: false } });
    expect(card(mount(TeamView), 'qa').find('.team-facts small').text()).toBe('最近 7 天');
  });

  test('offline members explain why and link to the runtime settings', async () => {
    useAppStore().activity = overview({ team: { available: false, busy: [], work: [] } });
    const open = vi.spyOn(useSettingsStore(), 'open').mockResolvedValue(undefined as never);
    const wrapper = mount(TeamView);
    const architect = card(wrapper, 'architect');
    expect(architect.find('.presence-text').text()).toBe('离线：找不到 Claude Code CLI');
    await architect.find('.team-facts button').trigger('click');
    expect(open).toHaveBeenCalledWith('environment');
  });

  test('before the first overview the spend shows a placeholder', () => {
    const wrapper = mount(TeamView);
    expect(card(wrapper, 'qa').find('.team-cost').text()).toBe('–');
    expect(card(wrapper, 'qa').find('.team-facts small').text()).toBe('还没有花费记录');
  });

  test('clicking a member in the sidebar opens the team page on that card', async () => {
    const app = useAppStore();
    app.activity = overview();
    const host = document.createElement('div');
    document.body.append(host);
    const sidebar = mount(SideBar, { attachTo: host });
    const page = mount(TeamView, { attachTo: document.body });

    const members = sidebar.findAll('button.team-member');
    expect(members).toHaveLength(4);
    await members[1].trigger('click');
    await flushPromises();

    expect(app.view).toBe('team');
    expect(document.activeElement?.id).toBe('team-architect');
    sidebar.unmount();
    page.unmount();
  });
});
