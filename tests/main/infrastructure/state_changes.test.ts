import { test } from 'vitest';
import assert from 'node:assert/strict';

import { createStateChangeEmitter } from '../../../src/main/infrastructure/state_changes.ts';
import type { StateChange } from '../../../src/shared/ipc/state.ts';

const nextTurn = () => {
  const { promise, resolve } = Promise.withResolvers<void>();
  queueMicrotask(resolve);
  return promise;
};

test('a burst merges domains without assigning old-repository changes to the next repository', async () => {
  let repositoryId: string | null = 'first';
  const changes: StateChange[] = [];
  const changed = createStateChangeEmitter(
    (change) => changes.push(change),
    () => repositoryId,
  );
  changed('packages');
  changed('packages', 'coding');
  repositoryId = 'second';
  changed('requirements');
  repositoryId = null;
  changed('notes');
  await nextTurn();
  assert.deepEqual(changes, [
    { repositoryId: 'first', domains: ['packages', 'coding'] },
    { repositoryId: 'second', domains: ['requirements'] },
    { repositoryId: null, domains: ['notes'] },
  ]);
});

test('a failed observer does not prevent later committed changes from being delivered', async () => {
  const received: StateChange[] = [];
  const changed = createStateChangeEmitter(
    (change) => {
      received.push(change);
      if (received.length === 1) throw new Error('observer failed');
    },
    () => 'repo',
  );
  changed('packages');
  await nextTurn();
  changed('release');
  await nextTurn();
  assert.deepEqual(
    received.map((change) => change.domains),
    [['packages'], ['release']],
  );
});
