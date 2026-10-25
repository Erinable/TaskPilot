import { test } from 'vitest';
import assert from 'node:assert/strict';

import * as board from '../../src/renderer/src/lib/board.ts';
import { taskView } from './execution_fakes.ts';
import type * as packageTypes from '../../src/shared/ipc/packages.ts';

const waitingOn = (blocking: boolean): packageTypes.PackageDependency => ({
  id: 'r1-wp1',
  title: '实现用例',
  status: 'in_progress',
  waived: !blocking,
  blocking,
});

test('every status lands in one column; deviation and blocked stay with the developer', () => {
  const statuses: packageTypes.WorkPackageStatus[] = ['clarifying', 'pending', 'in_progress', 'deviation', 'blocked', 'in_review', 'accepting', 'done'];
  assert.deepEqual(
    statuses.map((status) => board.columnOf({ status })),
    ['todo', 'todo', 'doing', 'doing', 'doing', 'review', 'accept', 'done'],
  );
  const grouped = board.groupByColumn(statuses.map((status, index) => taskView({ id: `t${index}`, status })));
  assert.deepEqual(
    Object.values(grouped).map((column) => column.length),
    [2, 3, 1, 1, 1],
  );
});

test('a card offers the column next step, and waits while a dependency blocks it', () => {
  assert.deepEqual(board.actionOf(taskView({ status: 'pending', humanTransitions: ['claim'] })), { kind: 'claim', label: '开始执行' });
  assert.deepEqual(board.actionOf(taskView({ status: 'pending', dependencies: [waitingOn(true)] })), { kind: 'wait', label: '等待前置' });
  assert.equal(board.actionOf(taskView({ status: 'pending', dependencies: [waitingOn(false)], humanTransitions: ['claim'] })).kind, 'claim');
  assert.equal(board.actionOf(taskView({ status: 'in_review' })).kind, 'wait');
  assert.equal(board.actionOf(taskView({ status: 'accepting' })).kind, 'accept');
});

test('flags name the waited-for package and the agents at work', () => {
  const flags = board.flagsOf(taskView({ status: 'pending', dependencies: [waitingOn(true)] }));
  assert.deepEqual(flags, [{ tone: 'info', text: '等待：实现用例' }]);
  assert.deepEqual(
    board.flagsOf(taskView({ status: 'deviation' })).map((flag) => flag.text),
    ['已报告偏差'],
  );
});

test('estimate versus actual: wall-clock from claim to done, overrun past 1.5x', () => {
  const finished = (estimate: string, hours: number, extra: Partial<packageTypes.TaskView> = {}) =>
    taskView({
      status: 'done',
      estimate,
      claimedAt: '2026-10-14T00:00:00.000Z',
      completedAt: new Date(Date.UTC(2026, 9, 14) + hours * 3_600_000).toISOString(),
      ...extra,
    });
  assert.deepEqual(board.timeText(finished('预计 2 小时', 2.5)), { text: '预计 2h · 实际 2.5h', overrun: false });
  assert.deepEqual(board.timeText(finished('预计 30 分钟', 1)), { text: '预计 30 分钟 · 实际 1h', overrun: true });
  // The stored number wins over the text; unparsable text still shows the actual time.
  assert.equal(board.timeText(finished('2h', 3, { estimateHours: 1 }))?.overrun, true);
  assert.deepEqual(board.timeText(finished('大概半天', 3)), { text: '实际 3h', overrun: false });
  assert.equal(board.timeText(taskView({ status: 'in_progress' })), null);

  const accuracy = board.estimateAccuracy([finished('预计 2 小时', 2), finished('预计 1 小时', 4), finished('预计 1 小时', 0.6), taskView()]);
  assert.deepEqual(accuracy, { ratio: 2 / 3, count: 3 });
  assert.equal(board.estimateAccuracy([taskView()]), null);
});

test('the layout defaults to the board and remembers a list choice', () => {
  assert.equal(board.readLayout(undefined), 'board');
  assert.equal(board.readLayout({ getItem: () => 'list' }), 'list');
  assert.equal(board.readLayout({ getItem: () => 'nonsense' }), 'board');
});
