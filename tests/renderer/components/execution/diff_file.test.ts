// @vitest-environment happy-dom
// A long patch renders its first lines until the developer asks for the rest.
import { beforeEach, expect, test } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { defineComponent, h } from 'vue';

import { mountView } from '../../mount_view.ts';
import DiffFile from '../../../../src/renderer/src/components/execution/DiffFile.vue';
import { installFakeApi, ok } from '../../ipc_fakes.ts';

const change = { path: 'src/big.ts', added: 5000, removed: 0, binary: false, untracked: false };

const mountWith = async (patch: string) => {
  installFakeApi({ diff: { file: () => ok(patch) } });
  const wrapper = await mountView(defineComponent({ render: () => h(DiffFile, { taskId: 'task-1', change }) }));
  await wrapper.get('.diff-file-header').trigger('click');
  await flushPromises();
  return wrapper;
};

beforeEach(() => setActivePinia(createPinia()));

test('a patch over the limit shows its first 2000 lines and the rest on request', async () => {
  const patch = Array.from({ length: 2500 }, (_, index) => `+line ${index}`).join('\n');
  const wrapper = await mountWith(patch);
  expect(wrapper.findAll('.diff-line')).toHaveLength(2000);
  expect(wrapper.get('.diff-show-all').text()).toBe('还有 500 行，显示全部');
  await wrapper.get('.diff-show-all').trigger('click');
  expect(wrapper.findAll('.diff-line')).toHaveLength(2500);
  expect(wrapper.find('.diff-show-all').exists()).toBe(false);
});

test('a short patch shows every line with no button', async () => {
  const wrapper = await mountWith('@@ -1 +1 @@\n-a\n+b');
  expect(wrapper.findAll('.diff-line')).toHaveLength(3);
  expect(wrapper.find('.diff-show-all').exists()).toBe(false);
});
