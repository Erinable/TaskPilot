// @vitest-environment happy-dom
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';

import ProjectList from '../../../src/renderer/src/components/ProjectList.vue';
import { useRepositoriesStore } from '../../../src/renderer/src/stores/repositories.ts';
import { useTasksStore } from '../../../src/renderer/src/stores/tasks.ts';
import { taskView } from '../execution_fakes.ts';
import type * as ipc from '../../../src/shared/ipc_types.ts';

vi.mock('../../../src/renderer/src/lib/feedback.ts', () => ({
  showToast: vi.fn(),
  announceAgent: vi.fn(),
  confirmAction: vi.fn(async () => true),
  openDialogs: { value: 0 },
}));

const repo = (id: string, overrides: Partial<ipc.Repository> = {}): ipc.Repository => ({
  id,
  root: `/work/${id}`,
  name: id,
  lastOpenedAt: '',
  current: false,
  missing: false,
  counts: { pending: 0, active: 0, accepting: 0 },
  ...overrides,
});

const mountList = (repositories: ipc.Repository[]) => {
  const store = useRepositoriesStore();
  store.repositories = repositories;
  store.currentId = repositories.find((entry) => entry.current)?.id ?? null;
  const switchTo = vi.spyOn(store, 'switchTo').mockResolvedValue(true);
  const relocate = vi.spyOn(store, 'relocate').mockResolvedValue(true);
  const add = vi.spyOn(store, 'add').mockResolvedValue(true);
  return { wrapper: mount(ProjectList), switchTo, relocate, add };
};

describe('ProjectList', () => {
  beforeEach(() => setActivePinia(createPinia()));

  test('lists every project with its waiting work; the open one counts from the live queue', async () => {
    useTasksStore().tasks = [taskView({ status: 'in_progress' }), taskView({ id: 't2', status: 'pending' })];
    const { wrapper } = mountList([
      repo('app', { current: true, counts: { pending: 9, active: 9, accepting: 9 } }),
      repo('api', { counts: { pending: 2, active: 1, accepting: 1 } }),
      repo('docs'),
    ]);
    const rows = wrapper.findAll('[data-project]');
    expect(rows.map((row) => row.find('.project-name').text())).toEqual(['app', 'api', 'docs']);
    expect(rows[0].attributes('aria-current')).toBe('true');
    expect(rows[0].find('.project-detail').text()).toBe('1 执行中 · 1 待执行');
    expect(rows[0].find('.nav-count').exists()).toBe(false);
    expect(rows[1].find('.project-detail').text()).toBe('1 执行中 · 1 待验收 · 2 待执行');
    expect(rows[1].find('.nav-count').text()).toBe('2');
    expect(rows[2].find('.project-detail').text()).toBe('没有待办');
  });

  test('a click switches to another project, relocates a missing one, and the open one does nothing', async () => {
    const { wrapper, switchTo, relocate } = mountList([repo('app', { current: true }), repo('api'), repo('gone', { missing: true })]);
    await wrapper.get('[data-project="app"]').trigger('click');
    await wrapper.get('[data-project="api"]').trigger('click');
    await wrapper.get('[data-project="gone"]').trigger('click');
    await flushPromises();
    expect(switchTo).toHaveBeenCalledTimes(1);
    expect(switchTo).toHaveBeenCalledWith('api');
    expect(relocate).toHaveBeenCalledWith('gone');
    expect(wrapper.get('[data-project="gone"] .project-detail').text()).toBe('找不到这个目录');
  });

  test('adding a project goes through the store', async () => {
    const { wrapper, add } = mountList([repo('app', { current: true })]);
    await wrapper.get('[data-action="add-project"]').trigger('click');
    expect(add).toHaveBeenCalled();
  });
});
