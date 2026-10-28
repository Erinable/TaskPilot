/** @module-tag integration */
// IPC channels of the tutor domain (src/main/ipc/tutor.ts, src/main/work_packages/tutor_service.ts):
// the hint ladder, its output filter, and what it records.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import * as practice from '../../../src/main/work_packages/practice.ts';
import { CHANNELS } from '../../../src/shared/ipc_channels.ts';
import { HIDDEN_CHECK_KIND } from '../../../src/main/courses/lab_hidden.ts';
import * as fixtures from './harness.ts';
import { captureExpectedErrors } from '../../fixtures/expected_errors.ts';

const ID = 'auth-edge-tests';

test('tutor: answers L1 from the committed scope files, once, and records the level', async () => {
  const { call, root, agentCalls, store } = await fixtures.harness({ agent: fixtures.fakeAgent(), seedState: { [ID]: fixtures.claimedState } });
  // A tracked scope file is read; an untracked one never is.
  await fs.mkdir(path.join(root, 'tests/auth'), { recursive: true });
  await fs.writeFile(path.join(root, 'tests/auth/login-user.test.ts'), 'untracked draft\n');

  assert.deepEqual((await call(CHANNELS.tutorGet, ID, 0)).data, { status: 'idle', levels: [], pending: null, opened: 0, maxLevel: 5, error: null });
  const running = (await call(CHANNELS.tutorAsk, ID, 0, 1)).data;
  assert.deepEqual([running.status, running.pending], ['running', 1]);
  const done = await fixtures.settleTutor(call, ID, 0);
  assert.equal(done.status, 'done', JSON.stringify(done.error));
  assert.equal(done.opened, 1);
  // L1 carries no code, whatever Tutor wrote.
  assert.equal(done.levels[0].answer.snippet, null);
  assert.equal(done.levels[0].filtered, true);
  const tutorCall = fixtures.callFor(agentCalls, 'tutor');
  assert.match(tutorCall.prompt, /1\. 在 `tests\/auth\/login-user\.test\.ts` 添加邮箱大小写不敏感的用例。 {3}<- this step/);
  assert.match(tutorCall.prompt, /at level 1 of 5\.\nLevel 1 of 5:/);
  assert.match(tutorCall.prompt, /<missing_files>\ntests\/auth\/login-user\.test\.ts/);
  assert.doesNotMatch(tutorCall.prompt, /untracked draft/);
  assert.deepEqual(tutorCall.schema.properties.snippet, { type: 'null' });
  assert.deepEqual(
    store.get(ID).hints.map((use) => [use.stepIndex, use.level, use.filtered]),
    [[0, 1, true]],
  );

  // Asking again returns the saved answer without another call or another record.
  const calls = agentCalls.length;
  assert.equal((await call(CHANNELS.tutorAsk, ID, 0, 1)).data.status, 'done');
  assert.equal(agentCalls.length, calls);
  assert.equal(store.get(ID).hints.length, 1);
});

test('tutor: levels open one at a time, each prompt sees the earlier ones, and L5 opens the reference', async () => {
  const seed = {
    ...fixtures.claimedState,
    referenceRun: { id: 'r1', status: 'ready', startedAt: '', finishedAt: '', error: null, files: [], costUsd: 0, revealedAt: null, source: 'run' },
  };
  const { call, agentCalls, store } = await fixtures.harness({ agent: fixtures.fakeAgent(), seedState: { [ID]: seed } });
  assert.equal((await call(CHANNELS.tutorAsk, ID, 0, 2)).error.code, 'level_locked');
  assert.equal((await call(CHANNELS.tutorAsk, ID, 0, 6)).error.code, 'invalid_level');
  for (const level of [1, 2, 3, 4]) {
    await call(CHANNELS.tutorAsk, ID, 0, level);
    assert.equal((await fixtures.settleTutor(call, ID, 0)).opened, level);
    assert.equal((await call(CHANNELS.tasksGet, ID)).data.referenceLock.unlocked, false);
  }
  const prompts = agentCalls.filter((item) => fixtures.stepOf(item.schema) === 'tutor').map((item) => item.prompt);
  assert.match(prompts[2], /<earlier_levels>\nL1: .+\n- [\s\S]*?\n\nL2: [\s\S]*<\/earlier_levels>/);
  // L4 keeps a snippet of up to 3 lines; another step's ladder is its own.
  const four = (await call(CHANNELS.tutorGet, ID, 0)).data.levels[3];
  assert.ok(four.answer.snippet);
  assert.equal((await call(CHANNELS.tutorAsk, ID, 1, 2)).error.code, 'level_locked');

  await call(CHANNELS.tutorAsk, ID, 0, 5);
  const five = await fixtures.settleTutor(call, ID, 0);
  assert.deepEqual([five.opened, five.levels.map((item) => item.level)], [5, [1, 2, 3, 4, 5]]);
  assert.deepEqual((await call(CHANNELS.tasksGet, ID)).data.referenceLock, { unlocked: true, reason: 'hints_used' });
  assert.deepEqual(
    store.get(ID).hints.map((use) => use.level),
    [1, 2, 3, 4, 5],
  );

  // Copies are counted; a release clears the ladder's records with the claim.
  assert.equal((await call(CHANNELS.tutorCopied, ID)).data, 1);
  assert.equal(store.get(ID).snippetCopies, 1);
  await call(CHANNELS.packagesTransition, ID, 'release');
  assert.deepEqual([store.get(ID).hints, store.get(ID).snippetCopies], [[], 0]);
});

test('tutor: an answer that repeats the reference is asked again once, then kept as text only', async () => {
  const seed = {
    ...fixtures.claimedState,
    referenceRun: { id: 'r1', status: 'ready', startedAt: '', finishedAt: '', error: null, files: [], costUsd: 0, revealedAt: null, source: 'run' },
  };
  const reference = [
    'const key = email.toLowerCase();',
    'const count = (failures.get(key) ?? 0) + 1;',
    'failures.set(key, count);',
    'return count >= MAX_FAILURES;',
  ];
  const leaking = {
    explanation: '核心就是计数。',
    hints: ['先 `const key = email.toLowerCase();`'],
    snippet: { language: 'ts', code: reference.join('\n') },
    terms: [],
  };
  let answers: unknown[] = [leaking, leaking];
  const agent: fixtures.FakeAgent = async (options) =>
    fixtures.stepOf(options.schema) === 'tutor' ? { output: answers.shift() ?? fixtures.TUTOR_ANSWER, costUsd: 0.01 } : fixtures.fakeAgent()(options);
  const h = await fixtures.harness({ agent, seedState: { [ID]: seed } });
  const file = practice.referencePath(h.repositories.dataDir(), ID);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `--- a/src/auth/login.ts\n+++ b/src/auth/login.ts\n@@ -1 +1,4 @@\n${reference.map((line) => `+${line}`).join('\n')}\n`);
  const honest = { ...fixtures.TUTOR_ANSWER, snippet: null };
  const climb = async (stepIndex: number) => {
    for (const level of [1, 2, 3, 4]) {
      answers = [honest];
      await h.call(CHANNELS.tutorAsk, ID, stepIndex, level);
      await fixtures.settleTutor(h.call, ID, stepIndex);
    }
  };
  await climb(0);
  answers = [leaking, leaking];
  await h.call(CHANNELS.tutorAsk, ID, 0, 5);
  await fixtures.settleTutor(h.call, ID, 0);
  const tutorCalls = h.agentCalls.filter((item) => fixtures.stepOf(item.schema) === 'tutor');
  assert.equal(tutorCalls.length, 6, 'L5 was asked twice');
  assert.match(tutorCalls[5].prompt, /repeated the reference solution/);
  const five = (await h.call(CHANNELS.tutorGet, ID, 0)).data.levels[4];
  assert.deepEqual([five.answer.snippet, five.answer.hints, five.filtered], [null, ['先 `…`'], true]);
  assert.equal(h.store.get(ID).hints[4].filtered, true);
  // Nothing of the reference's code reaches the renderer.
  assert.doesNotMatch(JSON.stringify((await h.call(CHANNELS.tutorGet, ID, 0)).data), /toLowerCase|MAX_FAILURES/);

  // At another step, a retry that writes its own code is kept.
  await climb(1);
  answers = [leaking, { ...leaking, hints: ['想想 key 该怎么规范化。'], snippet: { language: 'ts', code: "if (locked(user)) throw new Error('locked');" } }];
  await h.call(CHANNELS.tutorAsk, ID, 1, 5);
  const kept = (await fixtures.settleTutor(h.call, ID, 1)).levels[4];
  assert.deepEqual([kept.answer.snippet?.code, kept.filtered], ["if (locked(user)) throw new Error('locked');", false]);
});

test('tutor: L4 sees the failing public tests, never the hidden ones', async () => {
  const check = (kind: string, newFailures: string[]) => ({
    kind,
    stage: 'submit',
    blocking: true,
    baseline: 'none',
    status: 'fail',
    reason: null,
    newFailures,
    preexisting: [],
    fixed: [],
  });
  const review = {
    status: 'rejected',
    startedAt: '',
    finishedAt: '',
    error: null,
    checks: [check('test', ['login is case-insensitive for the email']), check(HIDDEN_CHECK_KIND, ['hidden-name-marker'])],
    acceptance: [],
  };
  const { call, agentCalls } = await fixtures.harness({ agent: fixtures.fakeAgent(), seedState: { [ID]: { ...fixtures.claimedState, review } } });
  for (const level of [1, 2, 3, 4]) {
    await call(CHANNELS.tutorAsk, ID, 0, level);
    await fixtures.settleTutor(call, ID, 0);
  }
  const prompts = agentCalls.filter((item) => fixtures.stepOf(item.schema) === 'tutor').map((item) => item.prompt);
  assert.match(prompts[3], /<failing_tests>\nlogin is case-insensitive for the email\n<\/failing_tests>/);
  assert.doesNotMatch(prompts[2], /failing_tests/);
  for (const prompt of prompts) assert.doesNotMatch(prompt, /hidden-name-marker/);
});

test('tutor: bad output fails the level, which can be retried', async () => {
  let output: unknown = { explanation: '', hints: [], snippet: null, terms: [] };
  const agent: fixtures.FakeAgent = async () => ({ output, costUsd: 0 });
  captureExpectedErrors((error) => 'code' in error && error.code === 'agent_bad_output' && error.message === 'explanation is empty');
  const { call, store } = await fixtures.harness({ agent, seedState: { [ID]: fixtures.claimedState } });
  await call(CHANNELS.tutorAsk, ID, 1, 1);
  const failed = await fixtures.settleTutor(call, ID, 1);
  assert.deepEqual([failed.status, failed.pending, failed.error.code, failed.opened], ['failed', 1, 'agent_bad_output', 0]);
  assert.deepEqual(store.get(ID).hints, [], 'a failed level is not recorded');
  output = fixtures.TUTOR_ANSWER;
  await call(CHANNELS.tutorAsk, ID, 1, 1);
  assert.equal((await fixtures.settleTutor(call, ID, 1)).status, 'done');
});

test('tutor: a running answer can be cancelled; an out-of-range step is refused', async () => {
  const agent: fixtures.FakeAgent = ({ signal }) =>
    new Promise((_resolve, reject) => {
      signal!.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'agent_cancelled' })));
    });
  const { call } = await fixtures.harness({ agent, seedState: { [ID]: fixtures.claimedState } });
  await call(CHANNELS.tutorAsk, ID, 0, 1);
  assert.deepEqual((await call(CHANNELS.repositoriesBusy)).data, [{ kind: 'tutor', label: '补充登录模块边界测试' }]);
  assert.equal((await call(CHANNELS.tutorCancel, ID, 0)).data, true);
  const state = await fixtures.settleTutor(call, ID, 0);
  assert.equal(state.error.code, 'agent_cancelled');
  assert.equal((await call(CHANNELS.tutorAsk, ID, 9, 1)).error.code, 'invalid_step');
});

test('tutor: explains with the tutorGuide of the course pack in use', async () => {
  const h = await fixtures.harness({ agent: fixtures.fakeAgent(), seedState: { [ID]: fixtures.claimedState } });
  await fixtures.useOsPack(h);
  await h.call(CHANNELS.tutorAsk, ID, 0, 1);
  await fixtures.settleTutor(h.call, ID, 0);
  const system = fixtures.callFor(h.agentCalls, 'tutor').systemPrompt!;
  assert.match(system, /\nConnect every step to the mechanism behind it\. Your job is to help them do one step/);
  assert.doesNotMatch(system, /new to programming/);
});
