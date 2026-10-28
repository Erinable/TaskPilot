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
import { installApi as installSettingsApi } from '../settings_fakes.ts';
import type * as activityTypes from '../../../src/shared/ipc/activity.ts';

vi.mock('../../../src/renderer/src/lib/feedback.ts', () => ({
  showToast: vi.fn(),
  announceAgent: vi.fn(),
  confirmAction: vi.fn(async () => true),
  openDialogs: { value: 0 },
}));

const MARKUP = '<img src=x onerror=alert(1)>';

const REVIEW: activityTypes.ActivityRecord = {
  kind: 'package_transition',
  packageId: 'p1',
  title: '登录接口',
  transition: 'review_passed',
  actor: 'agent',
  from: 'in_review',
  to: 'accepting',
  at: new Date().toISOString(),
};

const overview = (overrides: Partial<activityTypes.ActivityOverview> = {}): activityTypes.ActivityOverview => ({
  // The shared feed holds only the human's step; QA's review is older than its 20 newest.
  recent: [{ kind: 'requirement_created', requirementId: 'r1', title: '邮箱登录', at: new Date().toISOString() }],
  metrics: { doneThisWeek: 0, donePreviousWeek: 0, averageHours: null, averageHoursPrevious: null },
  team: {
    available: true,
    availableByAgent: { 'product-lead': true, architect: true, qa: true, 'release-manager': true, 'env-steward': true, tutor: true, 'coding-agent': false },
    busy: ['qa'],
    work: [{ agent: 'qa', kind: 'review', label: MARKUP }],
  },
  costs: {
    byAgent: { 'product-lead': 0.034, architect: 0, qa: 1.5, 'release-manager': 0, 'env-steward': 0, tutor: 0, 'coding-agent': 0 },
    since: '2026-10-07T02:00:00.000Z',
    partial: true,
  },
  teamRecent: { 'product-lead': [], architect: [], qa: [REVIEW], 'release-manager': [], 'env-steward': [], tutor: [], 'coding-agent': [] },
  timeZone: 'Asia/Shanghai',
  ...overrides,
});

const card = (wrapper: VueWrapper, agent: string) => wrapper.find(`#team-${agent}`);

describe('TeamView', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    installApi({ list: [] });
  });

  test('working members lead with a full card; the rest stay in TEAM order', () => {
    useAppStore().activity = overview();
    const wrapper = mount(TeamView);
    // QA works, coding-agent is offline.
    expect(wrapper.findAll('.team-card').map((node) => node.attributes('id'))).toEqual([
      'team-qa',
      'team-product-lead',
      'team-architect',
      'team-release-manager',
      'team-env-steward',
      'team-tutor',
      'team-coding-agent',
    ]);

    const qa = card(wrapper, 'qa');
    expect(qa.find('.team-expand').exists()).toBe(false);
    expect(qa.find('h2').text()).toBe('QA Partner');
    expect(qa.find('.presence-text').text()).toBe('工作中');
    // Package titles are model text: shown as text, never markup.
    expect(qa.find('.team-work').text()).toBe(`正在审查工作包「${MARKUP}」`);
    expect(qa.find('.team-work img').exists()).toBe(false);
    expect(qa.find('.team-cost').text()).toBe('$1.50');
    expect(qa.find('.team-facts small').text()).toBe('从 10 月 7 日开始统计');
    expect(qa.findAll('.team-recent li').map((item) => item.find('span').text())).toEqual(['审查通过，等你验收：登录接口']);
  });

  test('idle and offline members fold to a compact card that expands on request', async () => {
    useAppStore().activity = overview();
    const wrapper = mount(TeamView);
    const pm = card(wrapper, 'product-lead');
    expect(pm.find('.presence-text').text()).toBe('在线');
    expect(pm.find('.team-compact-line').text()).toContain('最近没有动态');
    expect(pm.find('.team-facts').exists()).toBe(false);
    expect(pm.find('.team-compact-line .empty-action').exists()).toBe(false);
    expect(card(wrapper, 'coding-agent').find('.team-compact-line .empty-action').text()).toBe('配置');

    const expand = pm.find('.team-expand');
    expect(expand.attributes('aria-expanded')).toBe('false');
    await expand.trigger('click');
    expect(expand.attributes('aria-expanded')).toBe('true');
    expect(pm.find('.team-cost').text()).toBe('$0.034');
    expect(pm.find('.team-facts dd').text()).toBe('空闲，等待下一项任务');
    expect(pm.find('.team-recent').text()).toContain('最近没有动态');
  });

  test('role notes start folded and open per card', async () => {
    useAppStore().activity = overview();
    const wrapper = mount(TeamView);
    expect(wrapper.findAll('.team-role')).toHaveLength(0);
    const qa = card(wrapper, 'qa');
    const toggle = qa.find('.team-role-toggle');
    expect(toggle.attributes('aria-expanded')).toBe('false');
    await toggle.trigger('click');
    expect(toggle.attributes('aria-expanded')).toBe('true');
    expect(qa.find('.team-role').text()).toContain('验收条件');
    expect(wrapper.findAll('.team-role')).toHaveLength(1);
  });

  test('a full recorded week drops the partial note', () => {
    useAppStore().activity = overview({ costs: { ...overview().costs, partial: false } });
    expect(card(mount(TeamView), 'qa').find('.team-facts small').text()).toBe('最近 7 天');
  });

  test('offline members explain why and link to the runtime settings', async () => {
    useAppStore().activity = overview({
      team: {
        available: false,
        availableByAgent: {
          'product-lead': false,
          architect: false,
          qa: false,
          'release-manager': false,
          'env-steward': false,
          tutor: false,
          'coding-agent': false,
        },
        busy: [],
        work: [],
      },
    });
    installSettingsApi();
    const settings = useSettingsStore();
    const wrapper = mount(TeamView);
    const architect = card(wrapper, 'architect');
    await architect.find('.team-expand').trigger('click');
    expect(architect.find('.team-facts dd').text()).toContain('暂时联系不上');
    await architect.find('.team-facts button').trigger('click');
    await flushPromises();
    expect(useAppStore().view).toBe('settings');
    expect(settings.activePage).toBe('agents');
    expect(settings.preferencesDraft?.agents.architect.cli).toBe('claude');
  });

  test('before the first overview the spend shows a placeholder', async () => {
    const wrapper = mount(TeamView);
    await card(wrapper, 'qa').find('.team-expand').trigger('click');
    expect(card(wrapper, 'qa').find('.team-cost').text()).toBe('–');
    expect(card(wrapper, 'qa').find('.team-facts small').text()).toBe('还没有花费记录');
  });
  test('the sidebar entry opens the team page', async () => {
    const app = useAppStore();
    app.activity = overview();
    const sidebar = mount(SideBar);
    await sidebar.find('button.team-entry').trigger('click');
    await flushPromises();
    expect(app.view).toBe('team');
  });

  test('member cards keep their ids so other pages can focus them', async () => {
    useAppStore().activity = overview();
    const page = mount(TeamView, { attachTo: document.body });
    document.getElementById('team-architect')?.focus();
    expect(document.activeElement?.id).toBe('team-architect');
    page.unmount();
  });
});
