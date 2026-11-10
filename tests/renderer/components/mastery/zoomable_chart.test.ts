// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { expect, onTestFinished, test, vi } from 'vitest';

import ZoomableChart from '../../../../src/renderer/src/components/mastery/ZoomableChart.vue';

vi.mock('@/components/notes/NoteChart.vue', () => ({
  default: { name: 'NoteChart', props: { lang: String, source: String, natural: Boolean }, template: '<pre data-chart>{{ source }}</pre>' },
}));

const mountChart = () => {
  const wrapper = mount(ZoomableChart, { props: { lang: 'mermaid', source: 'flowchart LR', label: '知识点图' }, attachTo: document.body });
  onTestFinished(() => wrapper.unmount());
  return wrapper;
};
const scaleOf = (wrapper: ReturnType<typeof mountChart>) => Number(/scale\(([\d.]+)\)/.exec(wrapper.get('[data-zoom-stage]').attributes('style') ?? '')?.[1]);

test('the chart is drawn at its natural size inside the zoom stage', () => {
  const wrapper = mountChart();
  expect(wrapper.find('[data-zoom-stage] [data-chart]').exists()).toBe(true);
  expect(wrapper.getComponent({ name: 'NoteChart' }).props('natural')).toBe(true);
  expect(wrapper.get('.zoom-percent').text()).toBe('100%');
});

test('the toolbar zooms in and out and shows the scale', async () => {
  const wrapper = mountChart();
  await wrapper.get('[data-action="zoom-in"]').trigger('click');
  expect(wrapper.get('.zoom-percent').text()).toBe('125%');
  expect(scaleOf(wrapper)).toBeCloseTo(1.25);
  await wrapper.get('[data-action="zoom-out"]').trigger('click');
  await wrapper.get('[data-action="zoom-out"]').trigger('click');
  expect(wrapper.get('.zoom-percent').text()).toBe('80%');
});

test('the wheel zooms and keys zoom from the focused viewport', async () => {
  const wrapper = mountChart();
  const viewport = wrapper.get('[data-zoom-viewport]');
  await viewport.trigger('wheel', { deltaY: -100, clientX: 0, clientY: 0 });
  expect(scaleOf(wrapper)).toBeGreaterThan(1);
  const zoomed = scaleOf(wrapper);
  await viewport.trigger('keydown', { key: '-' });
  expect(scaleOf(wrapper)).toBeLessThan(zoomed);
});

test('dragging pans the chart', async () => {
  const wrapper = mountChart();
  const viewport = wrapper.get('[data-zoom-viewport]');
  const element = viewport.element as HTMLElement;
  element.setPointerCapture = () => {};
  Object.defineProperty(element, 'clientWidth', { value: 800 });
  Object.defineProperty(element, 'clientHeight', { value: 460 });
  const start = wrapper.get('[data-zoom-stage]').attributes('style');
  await viewport.trigger('pointerdown', { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
  expect(viewport.classes()).toContain('dragging');
  await viewport.trigger('pointermove', { pointerId: 1, clientX: 130, clientY: 110 });
  await viewport.trigger('pointerup', { pointerId: 1 });
  expect(viewport.classes()).not.toContain('dragging');
  expect(wrapper.get('[data-zoom-stage]').attributes('style')).not.toBe(start);
});
