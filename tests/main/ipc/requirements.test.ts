// IPC channels of the requirements domain (src/main/ipc/requirements.ts).
import { test, vi } from 'vitest';
import assert from 'node:assert/strict';

import { CHANNELS } from '../../../src/shared/ipc_channels.ts';
import * as fixtures from './harness.ts';

// Runs real git and npm processes per test; slow machines and CI need the room.
vi.setConfig({ testTimeout: 20_000 });

test('requirements: create clarifies, plan publishes into the work queue', async () => {
  const { call, agentCalls } = await fixtures.harness({ agent: fixtures.fakeAgent() });
  const created = await call(CHANNELS.requirementsCreate, { text: '用户可以用邮箱登录' });
  assert.equal(created.data.status, 'clarifying');

  let item = await fixtures.settle(call, created.data.id);
  assert.equal(item.status, 'answering');
  assert.equal(item.questions[0].text, '连续失败几次锁定？');
  // Architect read the file; Product Lead saw the summary, never the source.
  assert.match(fixtures.callFor(agentCalls, 'summarize').prompt, /<file path="src\/auth\/application\/login-user\.ts">\nexport \{\};/);
  const clarifyCall = fixtures.callFor(agentCalls, 'clarify');
  assert.match(clarifyCall.prompt, /<interface_summary author="Architect">\nsrc\/auth\/application\/login-user\.ts: 登录用例占位/);
  assert.doesNotMatch(clarifyCall.prompt, /<file path=/);
  assert.equal(item.interfaces.read[0].path, 'src/auth/application/login-user.ts');

  await call(CHANNELS.requirementsPlan, item.id, ['5 次']);
  item = await fixtures.settle(call, item.id);
  assert.equal(item.status, 'reviewing');
  const planCall = fixtures.callFor(agentCalls, 'plan');
  assert.match(planCall.prompt, /A1: 5 次/);
  assert.match(planCall.prompt, /<interface_summary/, 'planning reuses the summary');
  assert.equal(agentCalls.filter((c) => fixtures.stepOf(c.schema) === 'summarize').length, 1, 'summarized once');

  const published = await call(CHANNELS.requirementsPublish, item.id);
  assert.equal(published.data.status, 'published');
  // Queued after the sample packages, which an older requirement published.
  const generated = (await call(CHANNELS.listTasks)).data.filter((task) => task.requirementId === item.id);
  assert.equal(generated[0].id, `${item.id}-wp1`);
  assert.deepEqual(generated[0].humanTransitions, ['claim']);

  // The new package is a real work package: it can be claimed.
  const claimed = await call(CHANNELS.transition, `${item.id}-wp1`, 'claim');
  assert.equal(claimed.data.status, 'in_progress');
});

test('requirements: without a submit test check, planning links no tests', async () => {
  const { call, agentCalls, setCommands } = await fixtures.harness({ agent: fixtures.fakeAgent() });
  const plan = async () => {
    const { data } = await call(CHANNELS.requirementsCreate, { text: '用户可以用邮箱登录' });
    await fixtures.settle(call, data.id);
    await call(CHANNELS.requirementsPlan, data.id, ['5 次']);
    return fixtures.settle(call, data.id);
  };
  setCommands({ lint: { command: 'npm', args: ['run', 'lint'] } });
  const unlinked = await plan();
  assert.match(agentCalls.filter((c) => fixtures.stepOf(c.schema) === 'plan').at(-1)!.prompt, /leave `test` out of every criterion/);
  // The fake plan links 'login succeeds'; it is dropped, not left to go missing.
  assert.deepEqual(unlinked.plan.packages[0].acceptance, [{ text: '成功返回 token' }]);

  setCommands({ test: fixtures.EDGE_TESTS_PASS });
  const linked = await plan();
  assert.deepEqual(linked.plan.packages[0].acceptance, [{ text: '成功返回 token', test: 'login succeeds' }]);
});

test('requirements: an invalid agent plan fails the run instead of reaching the queue', async () => {
  const evil = { ...fixtures.PLAN_OUTPUT, packages: [{ ...fixtures.PLAN_OUTPUT.packages[0], fileScope: ['../../.ssh/id_rsa'] }] };
  const { call } = await fixtures.harness({ agent: fixtures.fakeAgent({ plan: evil }) });
  const { data } = await call(CHANNELS.requirementsCreate, { text: 't' });
  await fixtures.settle(call, data.id);
  await call(CHANNELS.requirementsPlan, data.id, ['']);
  const item = await fixtures.settle(call, data.id);
  assert.equal(item.status, 'failed');
  assert.equal(item.failedStep, 'planning');
  assert.equal(item.error.code, 'agent_bad_output');
  assert.equal((await call(CHANNELS.requirementsPublish, data.id)).error.code, 'invalid_state');
});

test('requirements: agent errors are recorded and the step can be retried', async () => {
  let fail = true;
  const agent = async (options) => {
    if (fail) throw Object.assign(new Error('Claude Code CLI not found: claude'), { code: 'agent_unavailable' });
    return fixtures.fakeAgent()(options);
  };
  const { call } = await fixtures.harness({ agent });
  const { data } = await call(CHANNELS.requirementsCreate, { text: 't' });
  let item = await fixtures.settle(call, data.id);
  assert.equal(item.error.code, 'agent_unavailable');

  fail = false;
  await call(CHANNELS.requirementsClarify, data.id);
  item = await fixtures.settle(call, data.id);
  assert.equal(item.status, 'answering');
});

test('requirements: a running step can be cancelled', async () => {
  const agent: fixtures.FakeAgent = ({ signal }) =>
    new Promise((_resolve, reject) => {
      signal!.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'agent_cancelled' })));
    });
  const { call } = await fixtures.harness({ agent });
  const { data } = await call(CHANNELS.requirementsCreate, { text: 't' });
  assert.equal((await call(CHANNELS.requirementsCancel, data.id)).data, true);
  const item = await fixtures.settle(call, data.id);
  assert.equal(item.error.code, 'agent_cancelled');
  assert.equal((await call(CHANNELS.requirementsCancel, data.id)).data, false, 'nothing left to cancel');
});

test('requirements: published requirements cannot be deleted', async () => {
  const { call } = await fixtures.harness({ agent: fixtures.fakeAgent() });
  const { data } = await call(CHANNELS.requirementsCreate, { text: 't' });
  await fixtures.settle(call, data.id);
  await call(CHANNELS.requirementsPlan, data.id, ['']);
  await fixtures.settle(call, data.id);
  await call(CHANNELS.requirementsPublish, data.id);
  assert.equal((await call(CHANNELS.requirementsRemove, data.id)).error.code, 'invalid_state');
});

test('requirements: create rejects empty text before any agent runs', async () => {
  const { call, agentCalls } = await fixtures.harness({ agent: fixtures.fakeAgent() });
  const response = await call(CHANNELS.requirementsCreate, { text: '  ' });
  assert.equal(response.error.field, 'text');
  assert.equal(agentCalls.length, 0);
});
