// @vitest-environment happy-dom
import { beforeEach, expect, test, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';

import TeamTabs from '../../../src/renderer/src/components/TeamTabs.vue';
import { useAppStore } from '../../../src/renderer/src/stores/app.ts';

beforeEach(() => setActivePinia(createPinia()));

test('the three team pages are tabs; the current one is marked and others navigate', async () => {
  const app = useAppStore();
  app.view = 'activity';
  const navigate = vi.spyOn(app, 'navigate').mockResolvedValue(true);
  const wrapper = mount(TeamTabs);
  expect(wrapper.findAll('.team-tab').map((tab) => tab.text())).toEqual(['成员', '活动记录', '成本']);
  expect(wrapper.get('[data-team-tab="activity"]').attributes('aria-current')).toBe('page');
  await wrapper.get('[data-team-tab="activity"]').trigger('click');
  expect(navigate).not.toHaveBeenCalled();
  await wrapper.get('[data-team-tab="costs"]').trigger('click');
  await flushPromises();
  expect(navigate).toHaveBeenCalledWith('costs');
});
