// Mounts a view or component the way the app does: Element Plus and the
// active Pinia (setActivePinia first, so stores seeded before the mount are
// the ones it reads), attached to the document for teleported popovers, and
// unmounted when the test finishes. Resolves once the first loads settled.
import { getActivePinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import { onTestFinished } from 'vitest';
import type { Component } from 'vue';

export const mountView = async (component: Component) => {
  const pinia = getActivePinia();
  if (!pinia) throw new Error('mountView() needs setActivePinia() first');
  const wrapper = mount(component, { global: { plugins: [ElementPlus, pinia] }, attachTo: document.body });
  onTestFinished(() => wrapper.unmount());
  await flushPromises();
  return wrapper;
};
