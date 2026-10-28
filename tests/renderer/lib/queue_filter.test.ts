import { test } from 'vitest';
import assert from 'node:assert/strict';

import { FILTER_OPTIONS, countByFilter, filterQueue } from '../../../src/renderer/src/lib/queue_filter.ts';
import { STATUSES } from '../../../src/main/work_packages/work_package_status.ts';
import type * as packageTypes from '../../../src/shared/ipc/packages.ts';

const task = (id: string, status: packageTypes.WorkPackageStatus, priority: packageTypes.Priority) => ({ id, status, priority }) as packageTypes.TaskView;

const queue = [
  task('a', 'done', 'high'),
  task('b', 'pending', 'low'),
  task('c', 'in_review', 'high'),
  task('d', 'accepting', 'medium'),
  task('e', 'pending', 'high'),
];

test('the default view hides done packages and sorts by priority, keeping queue order within one', () => {
  assert.deepEqual(
    filterQueue(queue, 'active').map((item) => item.id),
    ['c', 'e', 'd', 'b'],
  );
});

test('filters split what the human can act on from what waits on agents', () => {
  assert.deepEqual(
    filterQueue(queue, 'mine').map((item) => item.id),
    ['e', 'd', 'b'],
  );
  assert.deepEqual(
    filterQueue(queue, 'waiting').map((item) => item.id),
    ['c'],
  );
  assert.deepEqual(
    filterQueue(queue, 'done').map((item) => item.id),
    ['a'],
  );
  assert.equal(filterQueue(queue, 'all').length, 5);
  assert.deepEqual(countByFilter(queue), { active: 4, mine: 3, waiting: 1, done: 1, all: 5 });
});

test('every status is reachable from a non-"all" filter', () => {
  const covered = new Set(
    FILTER_OPTIONS.filter((option) => option.value !== 'all').flatMap((option) =>
      filterQueue(
        Object.keys(STATUSES).map((status) => task(status, status as packageTypes.WorkPackageStatus, 'low')),
        option.value,
      ).map((item) => item.status),
    ),
  );
  assert.deepEqual([...covered].sort(), Object.keys(STATUSES).sort());
});
