import { test } from 'vitest';
import assert from 'node:assert/strict';

import * as activity from '../../src/renderer/src/lib/activity.ts';
import { TRANSITIONS } from '../../src/main/work_package_status.ts';
import type * as ipc from '../../src/shared/ipc_types.ts';

const SHANGHAI = 'Asia/Shanghai';
const metrics = (overrides: Partial<ipc.QueueMetrics>): ipc.QueueMetrics => ({ doneThisWeek: 0, donePreviousWeek: 0, averageHours: null, averageHoursPrevious: null, ...overrides });

test('every transition has feed wording attributed to the right actor', () => {
  for (const transition of TRANSITIONS) {
    const item = activity.toFeedItem({ kind: 'package_transition', packageId: 'p', title: 'T', transition: transition.name, actor: transition.actor, from: transition.from, to: transition.to, at: '2026-10-06T00:00:00Z' }, 0);
    assert.ok(item.what, transition.name);
    assert.equal(item.actor.avatar === 'you', transition.actor === 'human', transition.name);
  }
});

test('requirement events read as Product Lead or you', () => {
  const at = '2026-10-06T00:00:00Z';
  assert.equal(activity.toFeedItem({ kind: 'requirement_finished', requirementId: 'r', title: '邮箱登录', step: 'planning', costUsd: 0.1, at }, 0).what, '拆解出了工作包');
  assert.equal(activity.toFeedItem({ kind: 'requirement_published', requirementId: 'r', title: 'x', packageCount: 2, at }, 0).what, '发布了 2 个工作包');
  assert.equal(activity.toFeedItem({ kind: 'requirement_failed', requirementId: 'r', title: 'x', step: 'clarifying', code: 'agent_timeout', at }, 0).actor.name, 'Product Lead');
});

test('relativeTime() uses business-zone calendar days', () => {
  const now = new Date('2026-10-06T02:00:00Z'); // 10:00 in Shanghai
  assert.equal(activity.relativeTime('2026-10-06T01:59:40Z', now, SHANGHAI), '刚刚');
  assert.equal(activity.relativeTime('2026-10-06T01:52:00Z', now, SHANGHAI), '8 分钟前');
  assert.equal(activity.relativeTime('2026-10-05T17:00:00Z', now, SHANGHAI), '9 小时前'); // 01:00 today in Shanghai
  assert.equal(activity.relativeTime('2026-10-05T15:00:00Z', now, SHANGHAI), '昨天'); // 23:00 yesterday
  assert.equal(activity.relativeTime('2026-10-02T03:00:00Z', now, SHANGHAI), '10-02');
});

test('doneTrend() compares with last week', () => {
  assert.deepEqual(activity.doneTrend(metrics({})), { text: '本周暂无', tone: 'neutral' });
  assert.deepEqual(activity.doneTrend(metrics({ doneThisWeek: 3 })), { text: '上周没有', tone: 'up' });
  assert.deepEqual(activity.doneTrend(metrics({ doneThisWeek: 5, donePreviousWeek: 4 })), { text: '+25%', tone: 'up' });
  assert.deepEqual(activity.doneTrend(metrics({ doneThisWeek: 2, donePreviousWeek: 4 })), { text: '-50%', tone: 'down' });
  assert.deepEqual(activity.doneTrend(metrics({ doneThisWeek: 4, donePreviousWeek: 4 })), { text: '与上周持平', tone: 'neutral' });
});

test('durationTrend() treats shorter as better and small changes as stable', () => {
  assert.equal(activity.durationTrend(metrics({ averageHours: 2 })).text, '数据不足');
  assert.equal(activity.durationTrend(metrics({ averageHours: 2.1, averageHoursPrevious: 2 })).text, '较上周稳定');
  assert.deepEqual(activity.durationTrend(metrics({ averageHours: 1, averageHoursPrevious: 2 })), { text: '较上周缩短 50%', tone: 'up' });
  assert.deepEqual(activity.durationTrend(metrics({ averageHours: 3, averageHoursPrevious: 2 })), { text: '较上周变长 50%', tone: 'down' });
  assert.equal(activity.formatHours(2.44), '2.4h');
  assert.equal(activity.formatHours(30.6), '31h');
  assert.equal(activity.formatHours(null), '–');
});

test('presence follows CLI availability and running agents', () => {
  assert.equal(activity.presenceOf(null, 'qa'), 'offline');
  assert.equal(activity.presenceOf({ available: false, busy: [] }, 'qa'), 'offline');
  assert.equal(activity.presenceOf({ available: true, busy: ['qa'] }, 'qa'), 'busy');
  assert.equal(activity.presenceOf({ available: true, busy: ['qa'] }, 'architect'), 'online');
  assert.equal(activity.presenceSummary({ available: true, busy: [] }), '3 个 AI 成员在线');
  assert.equal(activity.presenceSummary({ available: true, busy: ['qa', 'architect'] }), '2 个 AI 成员正在工作');
  assert.equal(activity.presenceSummary({ available: false, busy: [] }), 'AI 团队离线');
});
