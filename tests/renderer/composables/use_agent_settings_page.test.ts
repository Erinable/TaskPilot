// @vitest-environment happy-dom
// The agents settings page clears its search when a field error appears,
// so the agent it names is visible, and not on unrelated changes.
import { beforeEach, expect, test, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount } from '@vue/test-utils';
import { defineComponent, h, nextTick } from 'vue';

import { useAgentSettingsPage } from '@/composables/use_agent_settings_page.ts';
import { useSettingsStore } from '@/stores/settings.ts';
import { installApi } from '../settings_fakes.ts';

vi.mock('@/lib/feedback.ts', () => ({ showToast: vi.fn(), confirmAction: vi.fn(), confirmChoice: vi.fn(), openDialogs: { value: 0 } }));

beforeEach(() => {
  setActivePinia(createPinia());
  installApi();
});

const mountPage = () => {
  let page: ReturnType<typeof useAgentSettingsPage> | null = null;
  const Page = defineComponent({
    setup: () => {
      page = useAgentSettingsPage();
      return () => h('div');
    },
  });
  mount(Page);
  return page!;
};

test('a new field error clears the search; editing errors that stay present does not', async () => {
  const settings = useSettingsStore();
  const page = mountPage();
  page.query.value = 'qa';
  settings.agentFieldErrors = { qa: { field: 'model', message: 'bad' } };
  await nextTick();
  expect(page.query.value).toBe('');

  page.query.value = 'arch';
  settings.agentFieldErrors = { ...settings.agentFieldErrors, architect: { field: 'cli', message: 'bad' } };
  await nextTick();
  expect(page.query.value).toBe('arch');

  settings.agentFieldErrors = {};
  await nextTick();
  settings.agentFieldErrors = { tutor: { field: 'thinking', message: 'bad' } };
  await nextTick();
  expect(page.query.value).toBe('');
});
