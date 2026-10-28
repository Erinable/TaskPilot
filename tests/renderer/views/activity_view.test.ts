// @vitest-environment happy-dom
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { Mock } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';

import ActivityView from '../../../src/renderer/src/views/ActivityView.vue';
import { useExecutionStore } from '../../../src/renderer/src/stores/execution.ts';
import { useTasksStore } from '../../../src/renderer/src/stores/tasks.ts';
import { installFakeApi, ok } from '../ipc_fakes.ts';
import { taskView } from '../execution_fakes.ts';
import type * as activityTypes from '../../../src/shared/ipc/activity.ts';
import type * as packageTypes from '../../../src/shared/ipc/packages.ts';
import type { IpcResult } from '../../../src/shared/ipc/envelope.ts';

const at = (iso: string) => iso;

const pages: Record<string, activityTypes.ActivityPage> = {
  first: {
    days: [
      {
        day: '2026-10-06',
        records: [
          {
            kind: 'package_transition',
            packageId: 'p1',
            title: '登录接口',
            transition: 'claim',
            actor: 'human',
            from: 'pending',
            to: 'in_progress',
            at: at('2026-10-06T02:05:00Z'),
          },
          { kind: 'requirement_finished', requirementId: 'gone', title: '<b>已删除的需求</b>', step: 'planning', costUsd: 0.1, at: at('2026-10-06T01:00:00Z') },
        ],
      },
    ],
    nextBefore: '2026-10-06',
    timeZone: 'Asia/Shanghai',
    retentionDays: 30,
  },
  second: {
    days: [{ day: '2026-10-02', records: [{ kind: 'requirement_created', requirementId: 'r0', title: '旧需求', at: at('2026-10-02T03:00:00Z') }] }],
    nextBefore: null,
    timeZone: 'Asia/Shanghai',
    retentionDays: 30,
  },
};

describe('ActivityView', () => {
  let page: Mock<(before: string | null) => Promise<IpcResult<activityTypes.ActivityPage>>>;

  beforeEach(() => {
    setActivePinia(createPinia());
    page = vi.fn((before: string | null) => ok(before ? pages.second : pages.first));
    installFakeApi({ activity: { page }, tasks: { get: () => ok(taskView({ id: 'p1' })) } });
    useTasksStore().tasks = [{ id: 'p1', title: '登录接口' } as packageTypes.TaskView];
  });

  const render = async () => {
    const wrapper = mount(ActivityView, { global: { plugins: [ElementPlus] } });
    await flushPromises();
    return wrapper;
  };

  test('groups events by business day with local times, and pages back', async () => {
    const wrapper = await render();
    expect(wrapper.findAll('.activity-day-label').length).toBe(1);
    const items = wrapper.findAll('.activity-item');
    expect(items[0].find('p').text()).toBe('你 开始执行');
    expect(items[0].find('time').text()).toBe('10:05');
    // Titles are text, never markup.
    expect(items[1].find('small').text()).toBe('<b>已删除的需求</b>');
    expect(wrapper.find('.activity-item b').exists()).toBe(false);

    await wrapper.find('.view-all-button').trigger('click');
    await flushPromises();
    expect(page).toHaveBeenLastCalledWith('2026-10-06');
    expect(
      wrapper
        .findAll('.activity-day-label')
        .map((node) => node.text())
        .at(-1),
    ).toBe('10 月 2 日');
    expect(wrapper.find('.view-all-button').exists()).toBe(false);
  });

  test('only events whose package or requirement still exists are clickable', async () => {
    const open = vi.spyOn(useExecutionStore(), 'open').mockResolvedValue();
    const wrapper = await render();
    const [claim, removed] = wrapper.findAll('.activity-item');
    expect(claim.element.tagName).toBe('BUTTON');
    expect(removed.element.tagName).toBe('DIV');
    await claim.trigger('click');
    expect(open).toHaveBeenCalledWith('p1');
  });

  test('the actor filter keeps only your actions or only the team', async () => {
    const wrapper = await render();
    // el-segmented is a radio group underneath.
    const radios = wrapper.findAll('.el-segmented input[type="radio"]');
    expect(radios).toHaveLength(3);
    await radios[2].setValue(true);
    await flushPromises();
    expect(wrapper.findAll('.activity-item').map((node) => node.find('strong').text())).toEqual(['Product Lead']);
  });
});
