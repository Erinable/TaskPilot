import { describe, expect, test } from 'vitest';

import { codingOutcome, codingPhase } from '../../../src/renderer/src/lib/coding_tracker.ts';
import { elapsedSince, formatElapsed } from '../../../src/renderer/src/lib/elapsed.ts';
import { nextStep } from '../../../src/renderer/src/lib/next_step.ts';
import { codingRun, taskView } from '../execution_fakes.ts';

const STARTED = '2026-10-15T00:00:00.000Z';

describe('elapsed time', () => {
  test('reads in seconds, minutes, then hours', () => {
    expect(formatElapsed(45_000)).toBe('45 秒');
    expect(formatElapsed(192_000)).toBe('3 分 12 秒');
    expect(formatElapsed(3_900_000)).toBe('1 小时 5 分');
    expect(formatElapsed(-5)).toBe('0 秒');
  });
  test('is null without a usable start time', () => {
    expect(elapsedSince(null, Date.now())).toBe(null);
    expect(elapsedSince('', Date.now())).toBe(null);
    expect(elapsedSince(STARTED, Date.parse(STARTED) + 61_000)).toBe('1 分 1 秒');
  });
});

describe('next step with the Coding Agent', () => {
  test('an untouched package offers the Coding Agent first', () => {
    const advice = nextStep(taskView({ status: 'in_progress', completedSteps: [] }));
    expect(advice.coding).toBe(true);
    expect(advice.text).toContain('交给 Coding Agent');
  });
  test('a running round says so and carries its start time', () => {
    const advice = nextStep(taskView({ status: 'in_progress', codingRun: codingRun({ status: 'running', attempt: 2, startedAt: STARTED }) }));
    expect(advice.coding).toBeUndefined();
    expect(advice.text).toContain('第 2 轮');
    expect(advice.since).toBe(STARTED);
  });
  test('a ready round asks for the file review; a timed-out one warns it may be unfinished', () => {
    expect(nextStep(taskView({ status: 'in_progress', codingRun: codingRun() })).text).toContain('逐个文件');
    expect(nextStep(taskView({ status: 'in_progress', codingRun: codingRun({ halt: 'timed_out' }) })).text).toContain('可能没写完');
  });
  test('a stopped loop hands back to the developer with submit as the action', () => {
    const advice = nextStep(taskView({ status: 'in_progress', codingRun: codingRun({ status: 'applied', halt: 'attempts_exhausted' }) }));
    expect(advice.action).toBe('submit_for_review');
  });
  test('done no longer points "below" for the commit panel', () => {
    expect(nextStep(taskView({ status: 'done' })).text).not.toContain('下面');
  });
});

describe('coding tracker', () => {
  test('a moving loop has a phase; one waiting for the developer has none', () => {
    expect(codingPhase(taskView({ codingRun: codingRun({ status: 'running', startedAt: STARTED }) }))).toEqual({ label: '第 1 轮编码中', since: STARTED });
    expect(codingPhase(taskView({ codingRun: codingRun({ status: 'verifying' }) }))?.label).toBe('提交前检查中');
    expect(codingPhase(taskView({ codingRun: codingRun({ status: 'ready', trigger: 'checks_failed' }) }))?.label).toBe('正在应用改动');
    expect(codingPhase(taskView({ status: 'in_review', codingRun: codingRun({ status: 'submitted' }) }))?.label).toBe('QA 审查中');
    expect(codingPhase(taskView({ codingRun: codingRun() }))).toBe(null);
    expect(codingPhase(taskView({ codingRun: codingRun({ status: 'running', halt: 'stopped' }) }))).toBe(null);
  });
  test('each way the flow stops has one plain sentence', () => {
    const title = taskView().title;
    expect(codingOutcome(taskView({ codingRun: codingRun() }))).toEqual({
      text: `Coding Agent 写好了「${title}」，等你逐个文件确认。`,
      tone: 'success',
      qa: false,
    });
    expect(codingOutcome(taskView({ codingRun: codingRun({ halt: 'timed_out' }) }))?.text).toContain('超时');
    expect(codingOutcome(taskView({ codingRun: codingRun({ status: 'applied', halt: 'attempts_exhausted' }) }))?.tone).toBe('error');
    expect(codingOutcome(taskView({ codingRun: codingRun({ status: 'failed', error: { code: 'coding_timeout', message: 'x' } }) }))?.text).toContain(
      '时间上限',
    );
    expect(codingOutcome(taskView({ status: 'accepting', codingRun: codingRun({ status: 'submitted' }) }))).toMatchObject({ qa: true, tone: 'success' });
    expect(codingOutcome(taskView({ status: 'in_progress', codingRun: codingRun({ status: 'cancelled' }) }))).toBe(null);
  });
});
