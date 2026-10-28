/** @module-tag integration */
// IPC channels of the requirements domain (src/main/ipc/requirements.ts).
import { test } from 'vitest';
import assert from 'node:assert/strict';

import { CHANNELS } from '../../../src/shared/ipc_channels.ts';
import * as fixtures from './harness.ts';

test.each(['', '  '])('requirements:create rejects empty text %j before the agent runs', async (text) => {
  const { call, agentCalls } = await fixtures.harness({ agent: fixtures.fakeAgent() });
  const response = await call(CHANNELS.requirementsCreate, { text });
  assert.equal(response.error.code, 'required');
  assert.equal(response.error.field, 'text');
  assert.equal(agentCalls.length, 0);
});

test('requirements: a published requirement cannot be deleted through IPC', async () => {
  const { call } = await fixtures.harness({ agent: fixtures.fakeAgent() });
  const { data } = await call(CHANNELS.requirementsCreate, { text: '用户可以用邮箱登录' });
  await fixtures.settle(call, data.id);
  await call(CHANNELS.requirementsPlan, data.id, ['5 次']);
  await fixtures.settle(call, data.id);
  await call(CHANNELS.requirementsPublish, data.id);
  assert.equal((await call(CHANNELS.requirementsRemove, data.id)).error.code, 'invalid_state');
});

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
  const generated = (await call(CHANNELS.tasksList)).data.filter((task) => task.requirementId === item.id);
  assert.equal(generated[0].id, `${item.id}-wp1`);
  assert.deepEqual(generated[0].humanTransitions, ['claim']);

  // The new package is a real work package: it can be claimed.
  const claimed = await call(CHANNELS.packagesTransition, `${item.id}-wp1`, 'claim');
  assert.equal(claimed.data.status, 'in_progress');
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

test('requirements: planning reads the course pack in use and snapshots it onto the plan and packages', async () => {
  const h = await fixtures.harness({ agent: fixtures.fakeAgent() });
  const { call, agentCalls } = h;
  const plan = async () => {
    const { data } = await call(CHANNELS.requirementsCreate, { text: '用户可以用邮箱登录' });
    await fixtures.settle(call, data.id);
    await call(CHANNELS.requirementsPlan, data.id, ['5 次']);
    return fixtures.settle(call, data.id);
  };
  // Not yet confirmed: Product Lead still plans as programming.
  await fixtures.useOsPack(h, { confirm: false });
  const pending = await plan();
  assert.equal(pending.plan.course.id, 'programming');
  assert.equal(pending.plan.course.source, 'builtin');
  assert.match(agentCalls.at(-1)!.systemPrompt!, /for a developer who may be new to programming/);

  const ref = await fixtures.useOsPack(h);
  const item = await plan();
  const planCall = agentCalls.filter((c) => fixtures.stepOf(c.schema) === 'plan').at(-1)!;
  assert.match(planCall.systemPrompt!, /plan software work for a student learning operating systems\./);
  assert.match(planCall.prompt, /Difficulty, for a student learning operating systems:\n- easy: uses an existing kernel facility\./);
  assert.match(planCall.prompt, /- practice: the core mechanism of the lab\./);
  assert.match(agentCalls.filter((c) => fixtures.stepOf(c.schema) === 'clarify').at(-1)!.systemPrompt!, /a student learning operating systems/);
  assert.deepEqual(item.plan.course, ref);

  await call(CHANNELS.requirementsPublish, item.id);
  const generated = (await call(CHANNELS.tasksList)).data.find((task) => task.requirementId === item.id);
  assert.deepEqual(generated.course, ref);
});
