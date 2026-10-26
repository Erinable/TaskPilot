// IPC channels of the tutor domain (src/main/ipc/tutor.ts).
import { test, onTestFinished, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { CHANNELS } from '../../../src/shared/ipc_channels.ts';
import * as fixtures from './harness.ts';

// Runs real git and npm processes per test; slow machines and CI need the room.
vi.setConfig({ testTimeout: 20_000 });

test('tutor: answers a step from the committed scope files, once', async () => {
  const { call, root, agentCalls } = await fixtures.harness({ agent: fixtures.fakeAgent(), seedState: { 'auth-edge-tests': fixtures.claimedState } });
  // A tracked scope file is read; an untracked one never is.
  await fs.mkdir(path.join(root, 'tests/auth'), { recursive: true });
  await fs.writeFile(path.join(root, 'tests/auth/login-user.test.ts'), 'untracked draft\n');

  assert.equal((await call(CHANNELS.tutorGet, 'auth-edge-tests', 0)).data.status, 'idle');
  assert.equal((await call(CHANNELS.tutorAsk, 'auth-edge-tests', 0)).data.status, 'running');
  const done = await fixtures.settleTutor(call, 'auth-edge-tests', 0);
  assert.equal(done.status, 'done', JSON.stringify(done.error));
  assert.equal(done.answer.hints.length, 2);
  const prompt = fixtures.callFor(agentCalls, 'tutor').prompt;
  assert.match(prompt, /1\. 在 `tests\/auth\/login-user\.test\.ts` 添加邮箱大小写不敏感的用例。 {3}<- this step/);
  assert.match(prompt, /<missing_files>\ntests\/auth\/login-user\.test\.ts/);
  assert.doesNotMatch(prompt, /untracked draft/);

  // Asking again returns the saved answer without another call.
  const calls = agentCalls.length;
  assert.equal((await call(CHANNELS.tutorAsk, 'auth-edge-tests', 0)).data.status, 'done');
  assert.equal(agentCalls.length, calls);
});

test('tutor: bad output fails the step, which can be retried', async () => {
  let output: unknown = { explanation: '', hints: [], snippet: null, terms: [] };
  const agent: fixtures.FakeAgent = async () => ({ output, costUsd: 0 });
  const { call } = await fixtures.harness({ agent, seedState: { 'auth-edge-tests': fixtures.claimedState } });
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  onTestFinished(() => errors.mockRestore());
  await call(CHANNELS.tutorAsk, 'auth-edge-tests', 1);
  const failed = await fixtures.settleTutor(call, 'auth-edge-tests', 1);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.code, 'agent_bad_output');
  output = fixtures.TUTOR_ANSWER;
  await call(CHANNELS.tutorAsk, 'auth-edge-tests', 1);
  assert.equal((await fixtures.settleTutor(call, 'auth-edge-tests', 1)).status, 'done');
});

test('tutor: a running answer can be cancelled; an out-of-range step is refused', async () => {
  const agent: fixtures.FakeAgent = ({ signal }) =>
    new Promise((_resolve, reject) => {
      signal!.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'agent_cancelled' })));
    });
  const { call } = await fixtures.harness({ agent, seedState: { 'auth-edge-tests': fixtures.claimedState } });
  await call(CHANNELS.tutorAsk, 'auth-edge-tests', 0);
  assert.deepEqual((await call(CHANNELS.repositoriesBusy)).data, [{ kind: 'tutor', label: '补充登录模块边界测试' }]);
  assert.equal((await call(CHANNELS.tutorCancel, 'auth-edge-tests', 0)).data, true);
  const state = await fixtures.settleTutor(call, 'auth-edge-tests', 0);
  assert.equal(state.error.code, 'agent_cancelled');
  assert.equal((await call(CHANNELS.tutorAsk, 'auth-edge-tests', 9)).error.code, 'invalid_step');
});

test('tutor: explains with the tutorGuide of the course pack in use', async () => {
  const h = await fixtures.harness({ agent: fixtures.fakeAgent(), seedState: { 'auth-edge-tests': fixtures.claimedState } });
  await fixtures.useOsPack(h);
  await h.call(CHANNELS.tutorAsk, 'auth-edge-tests', 0);
  await fixtures.settleTutor(h.call, 'auth-edge-tests', 0);
  const system = fixtures.callFor(h.agentCalls, 'tutor').systemPrompt!;
  assert.match(system, /\nConnect every step to the mechanism behind it\. Your job is to help them do one step/);
  assert.doesNotMatch(system, /new to programming/);
});
