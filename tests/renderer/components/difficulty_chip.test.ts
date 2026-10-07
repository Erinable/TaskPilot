// @vitest-environment happy-dom
import { describe, expect, test } from 'vitest';
import { mount } from '@vue/test-utils';

import DifficultyChip from '../../../src/renderer/src/components/DifficultyChip.vue';
import PlanPackageCard from '../../../src/renderer/src/components/requirements/PlanPackageCard.vue';
import { planPackage } from '../requirements_fakes.ts';

const MARKUP = '<img src=x onerror=alert(1)>';

describe('DifficultyChip', () => {
  test('shows the level with filled bars and the reason on hover', () => {
    const wrapper = mount(DifficultyChip, { props: { difficulty: { level: 'medium', reason: '要用到异步代码。' } } });
    const chip = wrapper.get('.difficulty-chip');
    expect(chip.text()).toBe('难度适中');
    expect(chip.classes()).toContain('medium');
    expect(chip.attributes('title')).toBe('难度：要用到异步代码。');
    expect(wrapper.findAll('.difficulty-bars .on')).toHaveLength(2);
    expect(wrapper.find('.difficulty-reason').exists()).toBe(false);
  });

  test('a package planned before difficulty existed shows nothing', () => {
    expect(mount(DifficultyChip, { props: { difficulty: undefined } }).html()).toBe('<!--v-if-->');
  });

  test('the plan card spells out the reason, as text', () => {
    const wrapper = mount(PlanPackageCard, { props: { pkg: planPackage({ difficulty: { level: 'hard', reason: MARKUP } }), index: 0 } });
    expect(wrapper.get('.difficulty-chip').text()).toBe('难度有挑战');
    expect(wrapper.get('.difficulty-reason').text()).toBe(MARKUP);
    expect(wrapper.find('img').exists()).toBe(false);
  });
});
