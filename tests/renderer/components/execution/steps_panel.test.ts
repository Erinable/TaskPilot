// @vitest-environment happy-dom
import { beforeEach, expect, test } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { defineComponent, h } from 'vue';
import { flushPromises } from '@vue/test-utils';

import StepsPanel from '../../../../src/renderer/src/components/execution/StepsPanel.vue';
import { useExecutionStore } from '../../../../src/renderer/src/stores/execution.ts';
import type * as packageTypes from '../../../../src/shared/ipc/packages.ts';
import { codingRun, installApi, taskView } from '../../execution_fakes.ts';
import { mountView } from '../../mount_view.ts';

let api: ReturnType<typeof installApi>;

beforeEach(() => {
  setActivePinia(createPinia());
});

const render = async (task: packageTypes.TaskView, folded = false) => {
  api = installApi({ task });
  const execution = useExecutionStore();
  execution.current = task;
  const wrapper = await mountView(defineComponent({ render: () => h(StepsPanel, { task: execution.current!, folded }) }));
  return { wrapper, execution };
};

test.each(['ai', null] as const)('an AI plan (%s) does not treat manual marks as coding completion', async (mode) => {
  const { wrapper } = await render(taskView({ mode, codingRun: codingRun(), completedSteps: [] }));
  expect(wrapper.get('.panel-heading p').text()).toBe('原计划 · 2 个步骤');
  expect(wrapper.text()).not.toContain('已完成');
  expect(wrapper.find('.progress-track').exists()).toBe(false);
  expect(wrapper.find('input[type="checkbox"]').exists()).toBe(false);
  expect(wrapper.findAll('.plan-step').map((step) => step.text())).toEqual(['1.新增 login()', '2.写测试']);
  expect(wrapper.findAll('[data-tutor]').length).toBe(2);
  expect(api.packages.setStepDone).not.toHaveBeenCalled();
});

test('an explicitly AI package uses a neutral plan before its first run', async () => {
  const { wrapper } = await render(taskView({ mode: 'ai', codingRun: null }));
  expect(wrapper.get('.panel-heading p').text()).toBe('原计划 · 2 个步骤');
  expect(wrapper.find('.progress-track').exists()).toBe(false);
});

test('manual marks do not strike through the AI plan', async () => {
  const { wrapper } = await render(taskView({ mode: 'ai', codingRun: codingRun(), completedSteps: [0] }));
  expect(wrapper.find('.step-item.done').exists()).toBe(false);
  expect(wrapper.get('.panel-heading p').text()).toBe('原计划 · 2 个步骤');
});

test('a folded acceptance plan can be opened with its original steps intact', async () => {
  const { wrapper } = await render(taskView({ mode: 'ai', status: 'accepting', codingRun: codingRun() }), true);
  const toggle = wrapper.get('[data-action="fold"]');
  expect(toggle.attributes('aria-expanded')).toBe('false');
  expect((wrapper.get('.step-list').element as HTMLElement).style.display).toBe('none');
  await toggle.trigger('click');
  expect(toggle.attributes('aria-expanded')).toBe('true');
  expect((wrapper.get('.step-list').element as HTMLElement).style.display).toBe('');
  expect(wrapper.findAll('.plan-step')).toHaveLength(2);
});

test.each(['self', 'practice'] as const)('%s retains the interactive checklist and Tutor', async (mode) => {
  const { wrapper, execution } = await render(taskView({ mode, codingRun: mode === 'self' ? codingRun() : null }));
  expect(wrapper.get('.panel-heading p').text()).toBe('0 / 2 已完成');
  expect(wrapper.find('.progress-track').exists()).toBe(true);
  expect(wrapper.get('[data-step-index="0"]').attributes('disabled')).toBeUndefined();
  expect(wrapper.findAll('[data-tutor]')).toHaveLength(2);
  await wrapper.get('[data-step-index="0"]').setValue(true);
  await flushPromises();
  expect(api.packages.setStepDone).toHaveBeenCalledWith('t1', 0, true);
  expect(execution.current?.completedSteps).toEqual([0]);
  expect(wrapper.get('.panel-heading p').text()).toBe('1 / 2 已完成');
  expect(wrapper.get('.progress-fill').attributes('style')).toContain('50%');
  expect(wrapper.findAll('[data-tutor]')).toHaveLength(1);
});
