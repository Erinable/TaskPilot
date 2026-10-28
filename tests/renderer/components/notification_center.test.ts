// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises } from '@vue/test-utils';

import { mountView } from '../mount_view.ts';
import NotificationCenter from '../../../src/renderer/src/components/NotificationCenter.vue';
import { useTasksStore } from '../../../src/renderer/src/stores/tasks.ts';
import { useRequirementsStore } from '../../../src/renderer/src/stores/requirements.ts';
import { useExecutionStore } from '../../../src/renderer/src/stores/execution.ts';
import { READ_STORAGE_KEY, useNotificationsStore } from '../../../src/renderer/src/stores/notifications.ts';
import { taskView } from '../execution_fakes.ts';
import { installApi, requirement } from '../requirements_fakes.ts';
import type * as requirementTypes from '../../../src/shared/ipc/requirements.ts';

vi.mock('../../../src/renderer/src/lib/feedback.ts', () => {
  const showToast = vi.fn();
  // announceAgent adds a system notification only in the background; tests see the toast.
  return { showToast, announceAgent: (...args: unknown[]) => showToast(...args), confirmAction: vi.fn(async () => true), openDialogs: { value: 0 } };
});

const MARKUP = '<img src=x onerror=alert(1)>';

describe('NotificationCenter', () => {
  let pinia: ReturnType<typeof createPinia>;
  let state: { list: requirementTypes.Requirement[] };
  let api: ReturnType<typeof installApi>;

  beforeEach(() => {
    localStorage.clear();
    document.body.replaceChildren();
    pinia = createPinia();
    setActivePinia(pinia);
    state = { list: [requirement({ title: MARKUP, updatedAt: '2026-01-04T00:00:00.000Z' })] };
    api = installApi(state);
    api.tasks.list.mockImplementation(() => Promise.resolve({ ok: true as const, data: [taskView({ status: 'blocked', title: '登录接口' })] as never[] }));
  });

  afterEach(() => useNotificationsStore().stop());

  const render = async () => {
    await useTasksStore().reloadQueue();
    await useRequirementsStore().refreshList();
    const wrapper = await mountView(NotificationCenter);
    return wrapper;
  };

  const openPopover = async (wrapper: Awaited<ReturnType<typeof render>>) => {
    // The popover opens on a timer.
    vi.useFakeTimers();
    try {
      await wrapper.find('button.icon-button').trigger('click');
      await vi.runAllTimersAsync();
    } finally {
      vi.useRealTimers();
    }
    await flushPromises();
    expect(wrapper.find('button.icon-button').attributes('aria-expanded')).toBe('true');
  };

  test('the bell shows the unread count and the dot only when something is unread', async () => {
    const wrapper = await render();
    const bell = wrapper.find('button.icon-button');
    expect(bell.attributes('aria-label')).toBe('通知（2 条未读）');
    expect(bell.find('[data-unread-dot]').exists()).toBe(true);

    useNotificationsStore().markAllRead();
    await flushPromises();
    expect(bell.attributes('aria-label')).toBe('通知');
    expect(bell.find('[data-unread-dot]').exists()).toBe(false);
  });

  test('opening the popover refreshes, and agent text stays text', async () => {
    const wrapper = await render();
    api.tasks.list.mockClear();
    api.requirements.list.mockClear();
    await openPopover(wrapper);
    expect(api.tasks.list).toHaveBeenCalledTimes(1);
    expect(api.requirements.list).toHaveBeenCalledTimes(1);
    const items = document.querySelectorAll('[data-notification]');
    expect(items).toHaveLength(2);
    expect(document.querySelector('.notification-center img')).toBeNull();
    // Timed items show a business-time-zone date; the blocked package has no time.
    expect(document.querySelector(`[data-notification^="r1:"] .notification-time`)?.textContent).toBe('01-04');
    expect(document.querySelector('[data-notification="t1:blocked"] .notification-time')).toBeNull();
    expect([...items].map((item) => item.querySelector('.notification-title')?.textContent)).toContain(MARKUP);
  });

  test('clicking an item navigates and marks it read', async () => {
    const wrapper = await render();
    const open = vi.spyOn(useExecutionStore(), 'open').mockResolvedValue();
    await openPopover(wrapper);
    (document.querySelector('[data-notification="t1:blocked"]') as HTMLButtonElement).click();
    await flushPromises();
    expect(open).toHaveBeenCalledWith('t1');
    expect(JSON.parse(localStorage.getItem(READ_STORAGE_KEY) ?? '[]')).toEqual(['t1:blocked']);
    expect(wrapper.find('button.icon-button').attributes('aria-label')).toBe('通知（1 条未读）');
  });

  test('全部标为已读 clears the badge', async () => {
    const wrapper = await render();
    await openPopover(wrapper);
    const button = document.querySelector('[data-mark-all]') as HTMLButtonElement;
    expect(button.textContent).toContain('全部标为已读');
    button.click();
    await flushPromises();
    expect(useNotificationsStore().unreadCount).toBe(0);
    expect(document.querySelectorAll('.notification-item.unread')).toHaveLength(0);
  });

  test('Escape closes the popover and returns focus to the bell', async () => {
    const wrapper = await render();
    await openPopover(wrapper);
    expect(wrapper.find('button.icon-button').attributes('aria-expanded')).toBe('true');
    document.querySelector('.notification-center')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flushPromises();
    expect(wrapper.find('button.icon-button').attributes('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(wrapper.find('button.icon-button').element);
  });

  test('an empty center says so', async () => {
    state.list = [];
    api.tasks.list.mockImplementation(() => Promise.resolve({ ok: true as const, data: [] as never[] }));
    const wrapper = await render();
    await openPopover(wrapper);
    expect(document.querySelector('.notification-empty')?.textContent).toBe('没有需要你处理的事项。');
  });
});
