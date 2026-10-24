import { describe, expect, test } from 'vitest';

import { nextStep } from '../../src/renderer/src/lib/next_step.ts';
import { taskView } from './execution_fakes.ts';

describe('nextStep', () => {
  test('points at the one action that moves the package on', () => {
    expect(nextStep(taskView({ status: 'pending' })).action).toBe('claim');
    expect(nextStep(taskView({ status: 'accepting' })).action).toBe('accepted');
    expect(nextStep(taskView({ status: 'blocked' })).action).toBe('unblock');
  });

  test('while executing, steps left means write code; all done means submit', () => {
    const working = nextStep(taskView({ status: 'in_progress', completedSteps: [0] }));
    expect(working.action).toBe(null);
    expect(working.text).toContain('（1 / 2）');
    expect(nextStep(taskView({ status: 'in_progress', completedSteps: [0, 1] })).action).toBe('submit_for_review');
  });

  test('the mode chosen at claim shapes the advice while steps remain', () => {
    const practice = nextStep(taskView({ status: 'in_progress', mode: 'practice' }));
    expect(practice.coding).toBeUndefined();
    expect(practice.text).toContain('Tutor');
    expect(nextStep(taskView({ status: 'in_progress', mode: 'ai' })).coding).toBe(true);
    expect(nextStep(taskView({ status: 'in_progress', mode: null })).coding).toBe(true);
  });

  test('AI-driven states and done have advice but no button', () => {
    for (const status of ['in_review', 'deviation', 'done'] as const) {
      const advice = nextStep(taskView({ status }));
      expect(advice.action).toBe(null);
      expect(advice.text).not.toBe('');
    }
  });
});
