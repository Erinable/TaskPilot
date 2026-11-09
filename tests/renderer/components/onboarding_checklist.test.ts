// @vitest-environment happy-dom
import { beforeEach, expect, test } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

import OnboardingChecklist from '@/components/OnboardingChecklist.vue';
import { mountView } from '../mount_view.ts';
import { agentStatus, installApi } from '../requirements_fakes.ts';
import { ok } from '../ipc_fakes.ts';

beforeEach(() => {
  setActivePinia(createPinia());
});

test('four required steps are numbered 1 through 4 and optional Codex has an icon', async () => {
  const api = installApi({ list: [] });
  api.agent.status.mockReturnValue(ok(agentStatus({ available: false, coding: { cli: 'codex', installed: false, signIn: null } })));
  const wrapper = await mountView(OnboardingChecklist);
  expect(wrapper.get('.panel-heading p').text()).toContain('完成这 4 步');
  expect(wrapper.get('.panel-heading p').text()).toContain('已完成 0 / 4');
  const required = wrapper.findAll('.onboarding-step:not(.optional)');
  expect(required.map((step) => step.get('.onboarding-mark').text())).toEqual(['1', '2', '3', '4']);
  expect(required.map((step) => step.attributes('value'))).toEqual(['1', '2', '3', '4']);
  const optional = wrapper.get('[data-step="coding"]');
  expect(optional.get('strong').text()).toContain('Codex（可选）');
  expect(optional.get('.onboarding-mark').text()).toBe('');
  expect(optional.find('.onboarding-mark svg').exists()).toBe(true);
  expect(optional.attributes('value')).toBeUndefined();
  expect(wrapper.get('.onboarding-step.next').attributes('data-step')).toBe('cli');
});

test('an optional CLI remains outside required progress when completed', async () => {
  installApi({ list: [] });
  const wrapper = await mountView(OnboardingChecklist);
  expect(wrapper.get('.panel-heading p').text()).toContain('已完成 1 / 4');
  expect(wrapper.get('[data-step="coding"]').classes()).toContain('done');
  expect(wrapper.get('[data-step="repository"] .onboarding-mark').text()).toBe('2');
  expect(wrapper.get('.onboarding-step.next').attributes('data-step')).toBe('repository');
});
