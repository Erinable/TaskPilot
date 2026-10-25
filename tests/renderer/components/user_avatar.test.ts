// @vitest-environment happy-dom
import { expect, test } from 'vitest';
import { mount } from '@vue/test-utils';

import AppIcon from '@/components/AppIcon.vue';
import UserAvatar from '@/components/UserAvatar.vue';

test('typing a separator-only name shows the default icon and can recover to initials', async () => {
  const wrapper = mount(UserAvatar, { props: { displayName: 'Ada Lovelace', avatarColor: 'ocean' } });
  expect(wrapper.text()).toBe('AL');
  await wrapper.setProps({ displayName: '---' });
  expect(wrapper.classes()).toContain('empty');
  expect(wrapper.classes()).toContain('ocean');
  expect(wrapper.getComponent(AppIcon).props('name')).toBe('user');
  await wrapper.setProps({ displayName: '韩国梁' });
  expect(wrapper.text()).toBe('韩');
  expect(wrapper.classes()).not.toContain('empty');
  wrapper.unmount();
});

test('an unknown display color falls back without changing the name', () => {
  const wrapper = mount(UserAvatar, { props: { displayName: 'Ada', avatarColor: 'neon' } });
  expect(wrapper.classes()).toContain('sunset');
  expect(wrapper.text()).toBe('A');
  wrapper.unmount();
});
