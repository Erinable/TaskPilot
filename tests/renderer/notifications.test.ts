import { describe, expect, test } from 'vitest';

import { deriveNotifications, pruneRead } from '../../src/renderer/src/lib/notifications.ts';
import { taskView } from './execution_fakes.ts';
import { requirement } from './requirements_fakes.ts';
import type * as ipc from '../../src/shared/ipc_types.ts';

const T1 = '2026-01-03T00:00:00.000Z';
const T2 = '2026-01-04T00:00:00.000Z';

const review = (status: 'passed' | 'rejected', finishedAt = T1): ipc.Review => ({
  status,
  startedAt: T1,
  finishedAt,
  error: null,
  reasons: [],
  attention: [],
  checks: [],
  verification: null,
  acceptance: [],
  report: null,
  diff: { files: [], skipped: [], outOfScope: [] },
  costUsd: 0,
});
const failedReview = (code = 'agent_timeout', finishedAt: string | null = T1): ipc.Review => ({
  status: 'failed',
  startedAt: T1,
  finishedAt,
  error: { code, message: 'x' },
});
const resolution = (decision: 'dismiss' | 'replan', reverted = false): ipc.DeviationResolution => ({
  decision,
  reason: 'r',
  changes: [],
  decidedAt: T1,
  afterContest: false,
  contested: false,
  reverted,
});
const deviation = (decision: 'dismiss' | 'replan', reverted = false): ipc.Deviation => ({
  note: 'n',
  stepIndex: null,
  filePath: null,
  reportedAt: T1,
  resolution: resolution(decision, reverted),
});
const doneAdjudication = (finishedAt = T1): ipc.Adjudication => ({
  status: 'done',
  mustReplan: false,
  startedAt: T1,
  finishedAt,
  error: null,
  read: [],
  skipped: [],
  costUsd: 0,
});

const one = (tasks: ipc.TaskView[], requirements: ipc.Requirement[] = []) =>
  deriveNotifications(tasks, requirements).map(({ id, text, at, target }) => ({ id, text, at, target }));

describe('deriveNotifications', () => {
  const pkg = { kind: 'package', id: 't1' };

  test.each([
    ['accepting', { status: 'accepting', review: review('passed') }, [{ id: `t1:accepting:${T1}`, text: '待你验收', at: T1, target: pkg }]],
    [
      'QA rejected while in progress',
      { status: 'in_progress', review: review('rejected') },
      [{ id: `t1:review:${T1}`, text: 'QA 退回了修改', at: T1, target: pkg }],
    ],
    [
      'QA failed',
      { status: 'in_review', review: failedReview() },
      [{ id: `t1:review-failed:${T1}`, text: 'QA 审查没有完成：智能体超过 3 分钟没有完成，已停止。', at: T1, target: pkg }],
    ],
    [
      'Architect dismissed',
      { status: 'in_progress', adjudication: doneAdjudication(), deviations: [deviation('dismiss')] },
      [{ id: `t1:adjudication:${T1}`, text: 'Architect 已裁决（驳回）', at: T1, target: pkg }],
    ],
    [
      'Architect replanned',
      { status: 'pending', adjudication: doneAdjudication(), deviations: [deviation('replan')] },
      [{ id: `t1:adjudication:${T1}`, text: 'Architect 已裁决（重新规划）', at: T1, target: pkg }],
    ],
    [
      'adjudication failed',
      { status: 'deviation', adjudication: { status: 'failed', mustReplan: false, startedAt: T1, finishedAt: T2, error: { code: 'boom', message: '炸了' } } },
      [{ id: `t1:adjudication-failed:${T2}`, text: '裁决没有完成：炸了', at: T2, target: pkg }],
    ],
    ['blocked', { status: 'blocked' }, [{ id: 't1:blocked', text: '已标记阻塞', at: null, target: pkg }]],
  ] as [string, Partial<ipc.TaskView>, unknown][])('%s', (_name, overrides, expected) => {
    expect(one([taskView(overrides)])).toEqual(expected);
  });

  test.each([
    ['plain in progress', { status: 'in_progress' }],
    ['rejected but resubmitted', { status: 'in_review', review: review('rejected') }],
    ['review running', { status: 'in_review', review: { status: 'running', startedAt: T1, finishedAt: null, error: null } }],
    ['review cancelled by the human', { status: 'in_progress', review: failedReview('agent_cancelled') }],
    [
      'adjudication cancelled',
      {
        status: 'deviation',
        adjudication: { status: 'failed', mustReplan: false, startedAt: T1, finishedAt: T1, error: { code: 'agent_cancelled', message: '' } },
      },
    ],
    ['replan reverted by the human', { status: 'in_progress', adjudication: doneAdjudication(), deviations: [deviation('replan', true)] }],
    ['done package keeps no old ruling', { status: 'done', review: review('passed'), adjudication: doneAdjudication(), deviations: [deviation('dismiss')] }],
  ] as [string, Partial<ipc.TaskView>][])('nothing for %s', (_name, overrides) => {
    expect(one([taskView(overrides)])).toEqual([]);
  });

  const req = { kind: 'requirement', id: 'r1' };
  test.each([
    ['answering', { status: 'answering' }, 'Product Lead 等你回答问题'],
    ['reviewing', { status: 'reviewing' }, '拆解完成，等你确认发布'],
    ['failed', { status: 'failed', error: { code: 'boom', message: '炸了' } }, '运行失败：炸了'],
  ] as [string, Partial<ipc.Requirement>, string][])('requirement %s', (_name, overrides, text) => {
    const item = requirement({ updatedAt: T2, ...overrides });
    expect(one([], [item])).toEqual([{ id: `r1:${item.status}:${T2}`, text, at: T2, target: req }]);
  });

  test.each(['draft', 'clarifying', 'planning', 'published'] as ipc.RequirementStatus[])('nothing for a %s requirement', (status) => {
    expect(one([], [requirement({ status })])).toEqual([]);
  });

  test('nothing for a requirement the human cancelled', () => {
    expect(one([], [requirement({ status: 'failed', error: { code: 'agent_cancelled', message: '' } })])).toEqual([]);
  });

  test('ids change when the underlying event changes', () => {
    const first = one([taskView({ review: review('rejected', T1) })])[0].id;
    const second = one([taskView({ review: review('rejected', T2) })])[0].id;
    expect(first).not.toBe(second);
    const answering = one([], [requirement({ status: 'answering', updatedAt: T1 })])[0].id;
    expect(one([], [requirement({ status: 'answering', updatedAt: T2 })])[0].id).not.toBe(answering);
    expect(one([], [requirement({ status: 'reviewing', updatedAt: T1 })])[0].id).not.toBe(answering);
    // The same state re-read keeps its id.
    expect(one([taskView({ review: review('rejected', T1) })])[0].id).toBe(first);
  });

  test('titles fall back for unnamed requirements and come from the package', () => {
    const items = deriveNotifications([taskView({ status: 'blocked', title: '登录接口' })], [requirement({ title: '', text: '' })]);
    expect(items.map((item) => item.title).sort()).toEqual(['未命名需求', '登录接口'].sort());
  });

  test('newest first, untimed last', () => {
    const items = deriveNotifications(
      [taskView({ id: 'old', status: 'accepting', review: review('passed', T1) }), taskView({ id: 'stuck', status: 'blocked' })],
      [requirement({ id: 'new', updatedAt: T2 })],
    );
    expect(items.map((item) => item.id)).toEqual([`new:answering:${T2}`, `old:accepting:${T1}`, 'stuck:blocked']);
  });
});

describe('pruneRead', () => {
  test('keeps only ids that still name a notification', () => {
    const items = deriveNotifications([taskView({ status: 'blocked' })], []);
    expect(pruneRead(['t1:blocked', 'gone:review:x'], items)).toEqual(['t1:blocked']);
  });
});
