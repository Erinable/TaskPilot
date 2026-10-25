import { test } from 'vitest';
import assert from 'node:assert/strict';

import * as activity from '../../src/renderer/src/lib/activity.ts';
import { TRANSITIONS } from '../../src/main/work_package_status.ts';
import { agentOf } from '../../src/main/activity_summary.ts';
import type { ActivityRecord, QueueMetrics, TeamStatus } from '../../src/shared/ipc/activity.ts';

const SHANGHAI = 'Asia/Shanghai';
const metrics = (overrides: Partial<QueueMetrics>): QueueMetrics => ({
  doneThisWeek: 0,
  donePreviousWeek: 0,
  averageHours: null,
  averageHoursPrevious: null,
  ...overrides,
});

test('every transition has feed wording attributed to the right actor', () => {
  for (const transition of TRANSITIONS) {
    const item = activity.toFeedItem(
      {
        kind: 'package_transition',
        packageId: 'p',
        title: 'T',
        transition: transition.name,
        actor: transition.actor,
        from: transition.from,
        to: transition.to,
        at: '2026-10-06T00:00:00Z',
      },
      0,
    );
    assert.ok(item.what, transition.name);
    assert.equal(item.actor.avatar === 'you', transition.actor === 'human', transition.name);
  }
});

test('requirement events read as Product Lead or you', () => {
  const at = '2026-10-06T00:00:00Z';
  assert.equal(
    activity.toFeedItem({ kind: 'requirement_finished', requirementId: 'r', title: '邮箱登录', step: 'planning', costUsd: 0.1, at }, 0).what,
    '拆解出了工作包',
  );
  assert.equal(activity.toFeedItem({ kind: 'requirement_published', requirementId: 'r', title: 'x', packageCount: 2, at }, 0).what, '发布了 2 个工作包');
  assert.equal(
    activity.toFeedItem({ kind: 'requirement_failed', requirementId: 'r', title: 'x', step: 'clarifying', code: 'agent_timeout', at }, 0).actor.name,
    'Product Lead',
  );
});

test('a finished release reads as Release Manager', () => {
  const item = activity.toFeedItem({ kind: 'release_finished', version: '1.2.0', packageCount: 3, at: '2026-10-06T00:00:00Z' }, 0);
  assert.equal(item.actor.name, 'Release Manager');
  assert.equal(item.actor.initials, 'RM');
  assert.match(item.what, /1\.2\.0/);
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
  const availableByAgent = { 'product-lead': true, architect: true, qa: true, 'release-manager': true, 'coding-agent': false } as const;
  assert.equal(activity.presenceOf({ available: false, availableByAgent, busy: [], work: [] }, 'qa'), 'offline');
  assert.equal(activity.presenceOf({ available: true, availableByAgent, busy: ['qa'], work: [] }, 'qa'), 'busy');
  assert.equal(activity.presenceOf({ available: true, availableByAgent, busy: ['qa'], work: [] }, 'architect'), 'online');
  assert.equal(activity.presenceOf({ available: true, availableByAgent, busy: [], work: [] }, 'coding-agent'), 'offline');
  assert.equal(activity.presenceSummary({ available: true, availableByAgent, busy: [], work: [] }), '4 个 AI 成员在线');
  assert.equal(activity.presenceSummary({ available: true, availableByAgent, busy: ['qa', 'architect'], work: [] }), '2 个 AI 成员正在工作');
  assert.equal(activity.presenceSummary({ available: false, availableByAgent, busy: [], work: [] }), 'AI 团队离线');
});

test('workText() names what a member is running, by kind', () => {
  const status: TeamStatus = {
    available: true,
    availableByAgent: { 'product-lead': true, architect: true, qa: true, 'release-manager': true, 'coding-agent': false },
    busy: ['architect', 'release-manager'],
    work: [
      { agent: 'architect', kind: 'adjudication', label: '登录接口' },
      { agent: 'release-manager', kind: 'release', label: null },
    ],
  };
  assert.equal(activity.workText(status, 'architect'), '正在裁决偏差「登录接口」');
  assert.equal(activity.workText(status, 'release-manager'), '正在起草「发布说明」');
  assert.equal(activity.workText(status, 'qa'), null);
  assert.equal(activity.workText(null, 'qa'), null);
});

test('formatCost() keeps three decimals under a dollar', () => {
  assert.equal(activity.formatCost(0), '$0.00');
  assert.equal(activity.formatCost(0.0342), '$0.034');
  assert.equal(activity.formatCost(1.5), '$1.50');
});

test("main's agentOf() names the same member the feed shows for every event", () => {
  const names = Object.fromEntries(activity.TEAM.map(({ agent, actor }) => [actor.name, agent]));
  const at = '2026-10-01T00:00:00.000Z';
  const records: ActivityRecord[] = [
    ...[...new Set(TRANSITIONS.map((item) => item.name))].map((transition): ActivityRecord => ({
      kind: 'package_transition',
      packageId: 'p',
      title: 't',
      transition: transition as never,
      actor: 'agent',
      from: 'pending',
      to: 'pending',
      at,
    })),
    ...(['breakdown_done', 'review_accepted', 'review_passed', 'review_rejected', 'replanned', 'deviation_dismissed'] as const).map(
      (transition): ActivityRecord => ({
        kind: 'package_transition',
        packageId: 'p',
        title: 't',
        transition,
        actor: 'agent',
        from: 'pending',
        to: 'pending',
        at,
      }),
    ),
    { kind: 'requirement_created', requirementId: 'r', title: 't', at },
    { kind: 'requirement_finished', requirementId: 'r', title: 't', step: 'planning', costUsd: null, at },
    { kind: 'requirement_failed', requirementId: 'r', title: 't', step: 'clarifying', code: 'x', at },
    { kind: 'requirement_published', requirementId: 'r', title: 't', packageCount: 1, at },
    { kind: 'release_finished', version: '1.0.0', packageCount: 1, at },
  ];
  for (const record of records) {
    const shown = names[activity.toFeedItem(record, 0).actor.name] ?? null;
    assert.equal(agentOf(record), shown, `${record.kind} ${'transition' in record ? record.transition : ''}`);
  }
});

test('members sort working, then online, then offline, keeping TEAM order within each', () => {
  const members = activity.TEAM.map(({ agent }, index) => ({ agent, presence: (['offline', 'busy', 'online', 'busy', 'online'] as const)[index] }));
  assert.deepEqual(
    activity.sortByPresence(members).map((member) => member.agent),
    ['architect', 'release-manager', 'qa', 'coding-agent', 'product-lead'],
  );
});

test('the sidebar work line names one worker, or the first and a count', () => {
  const availableByAgent = { 'product-lead': true, architect: true, qa: true, 'release-manager': true, 'coding-agent': true };
  const team = (busy: TeamStatus['busy'], work: TeamStatus['work'] = []): TeamStatus => ({ available: true, availableByAgent, busy, work });
  assert.equal(activity.teamWorkSummary(null), null);
  assert.equal(activity.teamWorkSummary(team([])), null);
  assert.equal(activity.teamWorkSummary(team(['architect'], [{ agent: 'architect', kind: 'review', label: 'x' }])), 'Architect 正在审查工作包…');
  assert.equal(activity.teamWorkSummary(team(['architect'])), 'Architect 正在工作…');
  // Named in TEAM order, whatever order the busy list arrives in.
  assert.equal(activity.teamWorkSummary(team(['qa', 'architect'])), 'Architect 等 2 人正在工作');
  // A member that is busy but unavailable counts as offline.
  assert.equal(activity.teamWorkSummary({ ...team(['qa']), available: false }), null);
});
