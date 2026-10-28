// IPC channels of the activity domain (src/main/ipc/activity.ts).
import { test, vi } from 'vitest';
import assert from 'node:assert/strict';

import { CHANNELS } from '../../../src/shared/ipc_channels.ts';
import * as fixtures from './harness.ts';

// Runs real git and npm processes per test; slow machines and CI need the room.
vi.setConfig({ testTimeout: 20_000 });

test('activity: the requirement flow and a claim are recorded, newest first', async () => {
  const { call } = await fixtures.harness({ agent: fixtures.fakeAgent() });
  const created = await call(CHANNELS.requirementsCreate, { text: '用户可以用邮箱登录' });
  let item = await fixtures.settle(call, created.data.id);
  await call(CHANNELS.requirementsPlan, item.id, ['5 次']);
  item = await fixtures.settle(call, item.id);
  await call(CHANNELS.requirementsPublish, item.id);
  await call(CHANNELS.packagesTransition, `${item.id}-wp1`, 'claim');

  const overview = await fixtures.overviewWith(call, 5);
  assert.deepEqual(
    overview.recent.map((record) => record.kind),
    ['package_transition', 'requirement_published', 'requirement_finished', 'requirement_finished', 'requirement_created'],
  );
  const [claim, published, planned] = overview.recent;
  assert.equal(claim.transition, 'claim');
  assert.equal(claim.actor, 'human');
  assert.equal(claim.title, '实现登录接口');
  assert.equal(published.packageCount, 1);
  assert.equal(planned.step, 'planning');
  assert.equal(overview.timeZone, 'Asia/Shanghai');
  assert.equal(overview.metrics.doneThisWeek, 0);
  // Each fake run costs $0.02: Architect selects and summarizes once, Product Lead clarifies and plans.
  assert.ok(Math.abs(overview.costs.byAgent.architect - 0.04) < 1e-9);
  assert.ok(Math.abs(overview.costs.byAgent['product-lead'] - 0.04) < 1e-9);
  assert.equal(overview.costs.byAgent.qa, 0);
  assert.equal(typeof overview.costs.since, 'string');
});

test('activity: QA finishing a review is recorded as an agent transition', async () => {
  const h = await fixtures.harness({ agent: fixtures.fakeAgent() });
  h.setCommands({ test: fixtures.EDGE_TESTS_PASS });
  await fixtures.submitEdgeTests(h);
  await fixtures.settleReview(h.call, 'auth-edge-tests');
  const overview = await fixtures.overviewWith(h.call, 3);
  const [review] = overview.recent;
  assert.equal(review.transition, 'review_passed');
  assert.equal(review.actor, 'agent');
  assert.equal(review.to, 'accepting');
  assert.ok(Math.abs(overview.costs.byAgent.qa - 0.02) < 1e-9);
});

test('activity: team status reports busy agents and CLI availability', async () => {
  let release: () => void = () => {};
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { call } = await fixtures.harness({
    agent: async (options) => {
      await blocked;
      return fixtures.fakeAgent()(options);
    },
  });
  const created = await call(CHANNELS.requirementsCreate, { text: '邮箱登录' });
  const { team } = (await call(CHANNELS.activityOverview)).data;
  assert.ok(team.busy.includes('architect') || team.busy.includes('product-lead'));
  assert.equal(team.work.length, 1);
  assert.equal(team.work[0].kind, 'requirement');
  assert.deepEqual(team.busy, [team.work[0].agent]);
  release();
  await fixtures.settle(call, created.data.id);
  const settled = (await call(CHANNELS.activityOverview)).data.team;
  assert.deepEqual(settled.busy, []);
  assert.deepEqual(settled.work, []);
});
