// @vitest-environment happy-dom
import { expect, onTestFinished, test, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';

vi.setConfig({ testTimeout: 20_000 });

import ConceptEditor from '@/components/courses/ConceptEditor.vue';
import { conceptErrors } from '@/lib/course_model.ts';
import { OS_COURSE } from '../../fixtures/builtin_courses.ts';
import type { Concept } from '@shared/course_pack.ts';

const node = (id: string, prerequisites: string[] = []): Concept => ({ id, label: id.toUpperCase(), summary: `${id} summary`, prerequisites });

// Mounts the editor on `concepts`, keeping v-model's value in `state.value`.
const mountEditor = (concepts: Concept[], errors: Record<string, string> = {}) => {
  const state = { value: concepts };
  const wrapper = mount(ConceptEditor, {
    props: {
      modelValue: concepts,
      errors,
      'onUpdate:modelValue': (value: Concept[]) => {
        state.value = value;
        wrapper.setProps({ modelValue: value });
      },
    },
    global: { plugins: [ElementPlus] },
    attachTo: document.body,
  });
  onTestFinished(() => wrapper.unmount());
  return { wrapper, state };
};

test('the checks match the main process: ids, repeats, unknown prerequisites, cycles, the limit', () => {
  expect(conceptErrors(OS_COURSE.concepts!)).toEqual({});
  expect(conceptErrors([node('a'), node('a'), node('Bad id')])).toEqual({
    'concepts[1].id': '和前面的知识点重复：a',
    'concepts[2].id': '小写字母开头，只用小写字母、数字、- 或 _，最长 32 个字符',
  });
  expect(conceptErrors([node('a', ['paging'])])['concepts[0].prerequisites']).toBe('不是本包的知识点：paging');
  expect(conceptErrors([node('a', ['c']), node('b', ['a']), node('c', ['b'])])['concepts[0].prerequisites']).toBe('前置关系成环：a → c → b → a');
  expect(conceptErrors(Array.from({ length: 201 }, (_, index) => node(`c${index}`))).concepts).toBe('最多 200 个知识点');
  expect(conceptErrors([{ ...node('a'), label: ' ', summary: '' }])).toEqual({ 'concepts[0].label': '名称不能为空', 'concepts[0].summary': '说明不能为空' });
});

test('concepts are added and removed, and a removed one leaves the others prerequisites', async () => {
  const { wrapper, state } = mountEditor([node('fcfs'), node('round-robin', ['fcfs'])]);
  await wrapper.get('[data-action="add-concept"]').trigger('click');
  expect(state.value.map((item) => item.id)).toEqual(['fcfs', 'round-robin', 'concept-3']);
  await flushPromises();
  // The new one has no name or summary yet.
  expect(wrapper.find('[data-error="concepts[2].label"]').exists()).toBe(true);
  await wrapper.findAll('[data-action="remove-concept"]')[0].trigger('click');
  expect(state.value).toEqual([node('round-robin'), { id: 'concept-3', label: '', summary: '', prerequisites: [] }]);
});

test('renaming an id carries the prerequisites that named it', async () => {
  const { wrapper, state } = mountEditor([node('fcfs'), node('round-robin', ['fcfs'])]);
  await wrapper.findAll('[aria-label="知识点 id"] input, input[aria-label="知识点 id"]')[0].setValue('first-come');
  expect(state.value[0].id).toBe('first-come');
  expect(state.value[1].prerequisites).toEqual(['first-come']);
});

test('prerequisites are picked from the other concepts, and a cycle shows on its field', async () => {
  const { wrapper } = mountEditor([node('a', ['b']), node('b', ['a']), node('c')]);
  await flushPromises();
  expect(wrapper.get('[data-error="concepts[0].prerequisites"]').text()).toBe('前置关系成环：a → b → a');
  // The options for a are the others, never itself.
  const select = wrapper
    .findAllComponents({ name: 'ElSelect' })
    .filter((item) => item.attributes('aria-label') === '前置知识点' || item.find('[aria-label="前置知识点"]').exists())[0];
  const options = select.findAllComponents({ name: 'ElOption' }).map((option) => option.props('label'));
  expect(options).toEqual(['B（b）', 'C（c）']);
});

test('the main process errors show on their field, over the local checks', async () => {
  const { wrapper } = mountEditor([node('a')], { 'concepts[0].summary': 'must not contain tags such as <work_package>' });
  await flushPromises();
  expect(wrapper.get('[data-error="concepts[0].summary"]').text()).toBe('must not contain tags such as <work_package>');
});

test('the dimension is optional; 不指定维度 leaves it out', async () => {
  const { wrapper, state } = mountEditor([{ ...node('a'), dimension: 'thinking' }]);
  (wrapper.findComponent({ name: 'ElSelect' }).vm as unknown as { $emit: (event: string, value: string) => void }).$emit('update:modelValue', '');
  await flushPromises();
  expect('dimension' in state.value[0]).toBe(false);
});
