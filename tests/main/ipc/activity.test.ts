// IPC channels of the activity domain (src/main/ipc/activity.ts).
import { test, onTestFinished, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { AgentRunError } from '../../../src/main/agents/claude_cli.ts';
import type { StructuredResult } from '../../../src/main/agents/claude_cli.ts';
import { CHANNELS } from '../../../src/shared/ipc_channels.ts';
import { SAMPLE_TASKS } from '../fixtures/sample_tasks.ts';
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
  await call(CHANNELS.transition, `${item.id}-wp1`, 'claim');

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

test('activity: a failed append never fails the action', async () => {
  const h = await fixtures.harness();
  // A file where the events directory should be makes every append fail.
  await fs.writeFile(path.join(h.repoDir, 'events'), '');
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  onTestFinished(() => errors.mockRestore());
  const claimed = await h.call(CHANNELS.transition, 'auth-edge-tests', 'claim');
  assert.equal(claimed.ok, true);
  await vi.waitFor(() => assert.ok(errors.mock.calls.some(([message]) => message === '[activity] append failed')));
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

test('costs: every analysis call is recorded with its CLI, model and work package, priced or not', async () => {
  const h = await fixtures.harness({
    agent: async (options) => {
      const result = (await fixtures.fakeAgent()(options)) as StructuredResult;
      return {
        ...result,
        costUsd: null,
        call: { cli: 'pi', provider: 'deepseek', model: 'v4', costUsd: null, tokens: { input: 9, output: 1, cacheRead: 0, cacheWrite: 0 } },
      };
    },
  });
  h.setCommands({ test: fixtures.EDGE_TESTS_PASS });
  await fixtures.submitEdgeTests(h);
  await fixtures.settleReview(h.call, 'auth-edge-tests');
  await h.activity.flush();
  const costs = (await h.activity.window(1)).filter((record) => record.kind === 'agent_cost');
  assert.equal(costs.length, 1);
  assert.deepEqual(costs[0], {
    kind: 'agent_cost',
    agent: 'qa',
    costUsd: null,
    call: { cli: 'pi', provider: 'deepseek', model: 'v4', costUsd: null, tokens: { input: 9, output: 1, cacheRead: 0, cacheWrite: 0 } },
    subject: { kind: 'package', id: 'auth-edge-tests' },
    at: costs[0].at,
  });
});

test('costs: a failed call and a paid-for schema retry are recorded too', async () => {
  const spent = (input: number) => ({
    cli: 'claude' as const,
    provider: 'anthropic',
    model: 'm',
    costUsd: input / 1000,
    tokens: { input, output: 1, cacheRead: 0, cacheWrite: 0 },
  });
  let reviews = 0;
  const h = await fixtures.harness({
    agent: async (options) => {
      if (fixtures.stepOf(options.schema) !== 'review') return fixtures.fakeAgent()(options);
      reviews += 1;
      // The first review fails after spending; the retry passes after one paid-for failed attempt.
      if (reviews === 1) throw new AgentRunError('model gave up', 'agent_failed', undefined, spent(10));
      return { ...((await fixtures.fakeAgent()(options)) as StructuredResult), call: spent(30), spentBefore: [spent(20)] };
    },
  });
  h.setCommands({ test: fixtures.EDGE_TESTS_PASS });
  await fixtures.submitEdgeTests(h);
  await fixtures.settleReview(h.call, 'auth-edge-tests');
  await h.call(CHANNELS.reviewRetry, 'auth-edge-tests');
  await fixtures.settleReview(h.call, 'auth-edge-tests');
  await h.activity.flush();
  const costs = (await h.activity.window(1)).flatMap((record) => (record.kind === 'agent_cost' && record.agent === 'qa' ? [record] : []));
  assert.deepEqual(
    costs.map((record) => record.call?.tokens?.input),
    [10, 20, 30],
  );
});

test('costs: the report rejects other ranges and counts recorded calls', async () => {
  const h = await fixtures.harness({ agent: fixtures.fakeAgent() });
  assert.equal((await h.call(CHANNELS.costsReport, 14)).ok, false);
  h.setCommands({ test: fixtures.EDGE_TESTS_PASS });
  await fixtures.submitEdgeTests(h);
  await fixtures.settleReview(h.call, 'auth-edge-tests');
  await h.activity.flush();
  const response = await h.call(CHANNELS.costsReport, 7);
  assert.equal(response.ok, true, JSON.stringify(response));
  const report = response.data as { total: { calls: number; actualUsd: number }; bySubject: { title: string }[]; prices: unknown };
  // fakeAgent reports $0.02 per call.
  assert.equal(report.total.calls, 1);
  assert.equal(report.total.actualUsd, 0.02);
  assert.equal(report.bySubject[0].title, SAMPLE_TASKS.find((task) => task.id === 'auth-edge-tests')?.title);
  assert.equal(report.prices, null);
});
