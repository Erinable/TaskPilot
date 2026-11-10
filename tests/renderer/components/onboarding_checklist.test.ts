// @vitest-environment happy-dom
import { beforeEach, expect, test } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises } from '@vue/test-utils';

import OnboardingChecklist from '@/components/OnboardingChecklist.vue';
import { mountView } from '../mount_view.ts';
import { agentStatus, installApi } from '../requirements_fakes.ts';
import { fail, ok } from '../ipc_fakes.ts';
import { useAppStore } from '@/stores/app.ts';
import { useOnboardingStore } from '@/stores/onboarding.ts';
import { useRequirementsStore } from '@/stores/requirements.ts';
import { expectConsole } from '../../fixtures/expected_console.ts';

beforeEach(() => {
  localStorage.removeItem('taskpilot.onboarding.path');
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

test('the learning goal opens the course interview directly without adding a project', async () => {
  const api = installApi({ list: [] });
  const wrapper = await mountView(OnboardingChecklist);
  await wrapper.get('[data-onboarding-path="course"]').trigger('click');
  expect(wrapper.get('[data-onboarding-path="course"]').attributes('aria-pressed')).toBe('true');
  expect(wrapper.find('[data-step="repository"]').exists()).toBe(false);
  expect(wrapper.find('[data-step="checks"]').exists()).toBe(false);
  await wrapper.get('[data-step="requirement"] button').trigger('click');
  await flushPromises();
  expect(useAppStore().view).toBe('requirements');
  expect(useRequirementsStore().composeKind).toBe('course');
  expect(api.repositories.add).not.toHaveBeenCalled();
  setActivePinia(createPinia());
  expect(useOnboardingStore().path).toBe('course');
});

test('the first failed readiness check stays visible and can be retried', async () => {
  const api = installApi({ list: [] });
  api.agent.status.mockReturnValueOnce(fail('agent_unavailable', 'CLI status unavailable'));
  expectConsole('error', /\[onboarding\] recheck failed/);
  const wrapper = await mountView(OnboardingChecklist);
  expect(wrapper.get('[role="alert"]').text()).toContain('准备状态读取失败');
  expect(wrapper.find('.onboarding-steps').exists()).toBe(false);
  await wrapper.get('[data-action="retry-onboarding"]').trigger('click');
  await flushPromises();
  expect(api.agent.status).toHaveBeenCalledTimes(2);
  expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  expect(wrapper.find('.onboarding-steps').exists()).toBe(true);
});

test('the expanded CLI help identifies the actual missing role and its login command', async () => {
  const api = installApi({ list: [] });
  const status = agentStatus();
  status.analysis.architect = { ...status.analysis.architect, cli: 'opencode', signIn: { state: 'signed_out', source: null } };
  api.agent.status.mockReturnValue(ok(status));
  const wrapper = await mountView(OnboardingChecklist);
  await wrapper.get('[data-step="cli"] > button').trigger('click');
  const help = wrapper.get('.onboarding-install');
  expect(help.text()).toContain('Architect · 登录 OpenCode');
  expect(help.text()).toContain('opencode auth login');
  expect(help.findAll('code').map((command) => command.text())).toEqual(['opencode auth login']);
});
