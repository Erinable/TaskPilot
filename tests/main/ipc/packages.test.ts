/** @module-tag integration */
// IPC channels of the packages domain (src/main/ipc/packages.ts).
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { TaskView } from '../../../src/shared/ipc/packages.ts';
import { CHANNELS } from '../../../src/shared/ipc_channels.ts';
import * as fixtures from './harness.ts';
import { until } from '../../fixtures/until.ts';

test('claiming reads the baseline from git, not from the renderer', async () => {
  const { call, root } = await fixtures.harness();
  const response = await call(CHANNELS.packagesTransition, 'auth-edge-tests', 'claim', { baseline: 'attacker-supplied' });
  assert.equal(response.ok, true);
  const head = (await fixtures.run('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
  assert.equal(response.data.baseline, head);
});

test('claiming records the chosen execution mode and refuses unknown ones', async () => {
  const { call } = await fixtures.harness();
  const bad = await call(CHANNELS.packagesTransition, 'auth-edge-tests', 'claim', { mode: 'pair' });
  assert.equal(bad.error.code, 'invalid_argument');
  assert.equal((await call(CHANNELS.tasksGet, 'auth-edge-tests')).data.status, 'pending');
  const claimed = await call(CHANNELS.packagesTransition, 'auth-edge-tests', 'claim', { mode: 'practice' });
  assert.equal(claimed.data.mode, 'practice');
  assert.equal((await call(CHANNELS.tasksGet, 'auth-edge-tests')).data.mode, 'practice');
});

test('the renderer cannot act as an agent', async () => {
  // QA starts on submit; hold it so the package stays in review.
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const { call, store, root, setCommands } = await fixtures.harness({
    agent: async () => {
      await held;
      return { output: fixtures.QA_PASS, costUsd: 0 };
    },
  });
  setCommands({ test: fixtures.EDGE_TESTS_PASS });
  await call(CHANNELS.packagesTransition, 'auth-edge-tests', 'claim');
  await fs.mkdir(path.join(root, 'tests/auth'), { recursive: true });
  await fs.writeFile(path.join(root, 'tests/auth/login-user.test.ts'), 'test("x", () => {});\n');
  await call(CHANNELS.packagesTransition, 'auth-edge-tests', 'submit_for_review');
  assert.equal(store.get('auth-edge-tests').status, 'in_review');
  // review_passed belongs to the QA agent; the renderer has no way to send it.
  const response = await call(CHANNELS.packagesTransition, 'auth-edge-tests', 'review_passed');
  assert.equal(response.error.code, 'wrong_actor');
  release();
});

test('review: submitting starts QA, which passes the package on to acceptance', async () => {
  const h = await fixtures.harness({ agent: fixtures.fakeAgent() });
  h.setCommands({ test: fixtures.EDGE_TESTS_PASS });
  const submitted = await fixtures.submitEdgeTests(h);
  assert.equal(submitted.data.review.status, 'running');

  const task = await fixtures.settleReview(h.call, 'auth-edge-tests');
  assert.equal(task.status, 'accepting');
  assert.equal(task.review.status, 'passed');
  assert.deepEqual(
    task.review.diff.files.map((f) => f.path),
    ['tests/auth/login-user.test.ts'],
  );
  const qaCall = fixtures.callFor(h.agentCalls, 'review');
  assert.match(qaCall.prompt, /case-insensitive/);
  assert.equal(task.review.verification.summary.passed, 2);
});

test('review: a QA rejection sends the package back with the issues', async () => {
  const h = await fixtures.harness({
    agent: fixtures.fakeAgent({
      review: {
        ...fixtures.QA_PASS,
        verdict: 'reject',
        issues: [{ severity: 'blocker', text: '用例没有断言', file: 'tests/auth/login-user.test.ts', line: 1 }],
      },
    }),
  });
  h.setCommands({ test: fixtures.EDGE_TESTS_PASS });
  await fixtures.submitEdgeTests(h);
  const task = await fixtures.settleReview(h.call, 'auth-edge-tests');
  assert.equal(task.status, 'in_progress');
  assert.equal(task.review.status, 'rejected');
  assert.deepEqual(task.review.reasons, ['qa_rejected', 'blocker']);
  assert.equal(task.review.report.issues[0].file, 'tests/auth/login-user.test.ts');
  // The developer can fix and resubmit.
  assert.ok(task.humanTransitions.includes('submit_for_review'));
});

test('review: a failed run stays in review and can be retried', async () => {
  let fail = true;
  const h = await fixtures.harness({
    agent: async (options) => {
      if (fail) throw Object.assign(new Error('timed out'), { code: 'agent_timeout' });
      return fixtures.fakeAgent()(options);
    },
  });
  h.setCommands({ test: fixtures.EDGE_TESTS_PASS });
  await fixtures.submitEdgeTests(h);
  let task = await fixtures.settleReview(h.call, 'auth-edge-tests');
  assert.equal(task.status, 'in_review');
  assert.equal(task.review.status, 'failed');
  assert.equal(task.review.error.code, 'agent_timeout');

  fail = false;
  const retried = await h.call(CHANNELS.reviewRetry, 'auth-edge-tests');
  assert.equal(retried.data.review.status, 'running');
  task = await fixtures.settleReview(h.call, 'auth-edge-tests');
  assert.equal(task.status, 'accepting');
  // A finished review cannot be retried.
  assert.equal((await h.call(CHANNELS.reviewRetry, 'auth-edge-tests')).error.code, 'invalid_state');
});

test('review: cancelling stops QA and leaves the package in review', async () => {
  const h = await fixtures.harness({
    agent: ({ signal }) =>
      new Promise((_resolve, reject) => {
        signal!.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'agent_cancelled' })));
      }),
  });
  h.setCommands({ test: fixtures.EDGE_TESTS_PASS });
  await fixtures.submitEdgeTests(h);
  // Wait until QA is actually waiting on the model.
  await until(
    async () => h.agentCalls.length,
    (count) => count > 0,
    'QA start',
  );
  assert.equal((await h.call(CHANNELS.reviewCancel, 'auth-edge-tests')).data, true);
  const task = await fixtures.settleReview(h.call, 'auth-edge-tests');
  assert.equal(task.status, 'in_review');
  assert.equal(task.review.error.code, 'agent_cancelled');
  assert.equal((await h.call(CHANNELS.reviewCancel, 'auth-edge-tests')).data, false);
});

test('review: failing tests reject without calling the model', async () => {
  const h = await fixtures.harness({ agent: fixtures.fakeAgent() });
  h.setCommands({ test: { command: process.execPath, args: ['-e', "console.log('not ok 1 - login is case-insensitive for the email'); process.exit(1)"] } });
  await fixtures.submitEdgeTests(h);
  const task = await fixtures.settleReview(h.call, 'auth-edge-tests');
  assert.equal(task.status, 'in_progress');
  assert.ok(task.review.reasons.includes('tests_failed'));
  assert.equal(fixtures.callFor(h.agentCalls, 'review'), undefined);
});

const settleBaseline = async (call, id) =>
  until(
    async () => (await call(CHANNELS.tasksGet, id)).data.baselineChecks,
    (baseline) => Boolean(baseline && baseline.status !== 'measuring'),
    'baseline',
  );

const settleAdjudication = async (call, id) => {
  await until(
    async () => (await call(CHANNELS.tasksGet, id)).data,
    (task) => task.adjudication?.status !== 'running',
    'adjudication',
  );
  return (await call(CHANNELS.tasksGet, id)).data;
};

const reportDeviation = async ({ call }) => {
  await call(CHANNELS.packagesTransition, 'auth-edge-tests', 'claim');
  return call(CHANNELS.packagesTransition, 'auth-edge-tests', 'report_deviation', {
    deviation: { note: '测试文件应该叫 login.test.ts', filePath: 'src/auth/application/login-user.ts' },
  });
};

test('baseline: a dirty tree is unavailable until it is cleaned and re-measured', async () => {
  const h = await fixtures.harness();
  h.setCommands({ test: fixtures.EDGE_TESTS_PASS });
  await fs.writeFile(path.join(h.root, 'src/auth/application/login-user.ts'), 'export const dirty = 1;\n');
  await h.call(CHANNELS.packagesTransition, 'auth-edge-tests', 'claim');
  // The status is readable before the first run has left the registry, so
  // wait for the run itself before measuring again.
  await h.idle();
  assert.equal((await h.call(CHANNELS.tasksGet, 'auth-edge-tests')).data.baselineChecks.reason, 'dirty_tree');
  await fixtures.run('git', ['checkout', '--', '.'], { cwd: h.root });
  assert.equal((await h.call(CHANNELS.packagesMeasureBaseline, 'auth-edge-tests')).ok, true);
  await h.idle();
  assert.equal((await h.call(CHANNELS.tasksGet, 'auth-edge-tests')).data.baselineChecks.status, 'measured');
});

test('review: a failure present in the IPC baseline is attention, not rejection', async () => {
  const h = await fixtures.harness({ agent: fixtures.fakeAgent() });
  h.setCommands({
    test: {
      command: process.execPath,
      args: [
        '-e',
        "console.log('ok 1 - login is case-insensitive for the email\\nok 2 - account locks after five failed attempts\\nnot ok 3 - legacy report export'); process.exit(1)",
      ],
    },
  });
  await h.call(CHANNELS.packagesTransition, 'auth-edge-tests', 'claim');
  await settleBaseline(h.call, 'auth-edge-tests');
  await fs.mkdir(path.join(h.root, 'tests/auth'), { recursive: true });
  await fs.writeFile(path.join(h.root, 'tests/auth/login-user.test.ts'), 'test("case-insensitive", () => {});\n');
  await h.call(CHANNELS.packagesTransition, 'auth-edge-tests', 'submit_for_review');
  const task = await fixtures.settleReview(h.call, 'auth-edge-tests');
  assert.equal(task.status, 'accepting');
  assert.deepEqual(task.review.checks[0].preexisting, ['legacy report export']);
});

test('review: without an IPC baseline the same failure rejects', async () => {
  const h = await fixtures.harness({ agent: fixtures.fakeAgent() });
  await h.call(CHANNELS.packagesTransition, 'auth-edge-tests', 'claim');
  await settleBaseline(h.call, 'auth-edge-tests');
  h.setCommands({ test: { command: process.execPath, args: ['-e', "console.log('not ok 1 - legacy report export'); process.exit(1)"] } });
  await fs.mkdir(path.join(h.root, 'tests/auth'), { recursive: true });
  await fs.writeFile(path.join(h.root, 'tests/auth/login-user.test.ts'), 'x\n');
  await h.call(CHANNELS.packagesTransition, 'auth-edge-tests', 'submit_for_review');
  const task = await fixtures.settleReview(h.call, 'auth-edge-tests');
  assert.equal(task.status, 'in_progress');
  assert.equal(task.review.checks[0].reason, 'no_baseline');
});

test('deviation: Architect reads the code and its replan becomes the package, which the human can revert', async () => {
  const h = await fixtures.harness({ agent: fixtures.fakeAgent() });
  const reported = await reportDeviation(h);
  assert.equal(reported.data.adjudication.status, 'running');

  let task = await settleAdjudication(h.call, 'auth-edge-tests');
  assert.equal(task.status, 'pending');
  assert.deepEqual(task.fileScope, ['tests/auth/login.test.ts']);
  assert.equal(task.revision.version, 1);
  assert.ok(task.humanTransitions.includes('revert_replan'));
  // The file named in the deviation was read from git and sent to Architect.
  const prompt = fixtures.callFor(h.agentCalls, 'adjudicate').prompt;
  assert.match(prompt, /<file path="src\/auth\/application\/login-user\.ts">\nexport \{\};/);
  assert.match(prompt, /D1 \[file src\/auth\/application\/login-user\.ts\]: 测试文件应该叫 login\.test\.ts/);

  const reverted = await h.call(CHANNELS.packagesTransition, 'auth-edge-tests', 'revert_replan');
  assert.equal(reverted.data.status, 'in_progress');
  task = (await h.call(CHANNELS.tasksGet, 'auth-edge-tests')).data;
  assert.deepEqual(task.fileScope, ['tests/auth/login-user.test.ts']);
  assert.equal(task.revision, null);
});

test('deviation: a contested dismissal goes back to Architect, which must replan', async () => {
  let decision = 'dismiss';
  const h = await fixtures.harness({
    agent: fixtures.fakeAgent({
      get adjudicate() {
        return decision === 'dismiss' ? { decision, reason: '按原计划即可', changes: [] } : fixtures.ADJUDICATE_REPLAN;
      },
    }),
  });
  await reportDeviation(h);
  let task = await settleAdjudication(h.call, 'auth-edge-tests');
  assert.equal(task.status, 'in_progress');
  assert.equal(task.deviations[0].resolution.decision, 'dismiss');
  assert.ok(task.humanTransitions.includes('override_dismissal'));

  decision = 'replan';
  await h.call(CHANNELS.packagesTransition, 'auth-edge-tests', 'override_dismissal');
  task = await settleAdjudication(h.call, 'auth-edge-tests');
  assert.equal(task.status, 'pending');
  const prompts = h.agentCalls.filter((c) => fixtures.stepOf(c.schema) === 'adjudicate').map((c) => c.prompt);
  assert.match(prompts[1], /contested your earlier dismissal/);
});

test('deviation: a failed ruling stays in deviation and can be retried', async () => {
  let fail = true;
  const h = await fixtures.harness({
    agent: async (options) => {
      if (fail) throw Object.assign(new Error('timed out'), { code: 'agent_timeout' });
      return fixtures.fakeAgent()(options);
    },
  });
  await reportDeviation(h);
  let task = await settleAdjudication(h.call, 'auth-edge-tests');
  assert.equal(task.status, 'deviation');
  assert.equal(task.adjudication.error.code, 'agent_timeout');

  fail = false;
  await h.call(CHANNELS.deviationRetry, 'auth-edge-tests');
  task = await settleAdjudication(h.call, 'auth-edge-tests');
  assert.equal(task.status, 'pending');
});

test('review: a clean pass with a measured baseline finishes the package without the human', async () => {
  const h = await fixtures.harness({ agent: fixtures.fakeAgent() });
  // The linked tests only exist once the developer writes the file, so the
  // baseline cannot already pass them.
  h.setCommands({
    test: {
      command: process.execPath,
      args: [
        '-e',
        "if (require('fs').existsSync('tests/auth/login-user.test.ts')) console.log('ok 1 - login is case-insensitive for the email\\nok 2 - account locks after five failed attempts'); else console.log('ok 1 - placeholder');",
      ],
    },
  });
  await h.call(CHANNELS.packagesTransition, 'auth-edge-tests', 'claim');
  await settleBaseline(h.call, 'auth-edge-tests');
  await fs.mkdir(path.join(h.root, 'tests/auth'), { recursive: true });
  await fs.writeFile(path.join(h.root, 'tests/auth/login-user.test.ts'), 'test("case-insensitive", () => {});\n');
  await h.call(CHANNELS.packagesTransition, 'auth-edge-tests', 'submit_for_review');
  const task = await fixtures.settleReview(h.call, 'auth-edge-tests');
  assert.deepEqual(task.review.attention, []);
  assert.equal(task.status, 'done');
});

test('dependencies: a package waits for its predecessor, and the developer can waive it', async () => {
  const second = { ...fixtures.PLAN_OUTPUT.packages[0], title: '接入登录路由', dependsOn: [1] };
  const h = await fixtures.harness({ agent: fixtures.fakeAgent({ plan: { ...fixtures.PLAN_OUTPUT, packages: [fixtures.PLAN_OUTPUT.packages[0], second] } }) });
  const { first, second: next } = await fixtures.publishChain(h);
  const waiting = (await h.call(CHANNELS.tasksGet, next)).data as TaskView;
  assert.deepEqual(waiting.dependencies, [{ id: first, title: '实现登录接口', status: 'pending', waived: false, blocking: true }]);

  const refused = await h.call(CHANNELS.packagesTransition, next, 'claim');
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, 'dependencies_pending');

  assert.equal((await h.call(CHANNELS.packagesWaiveDependency, next, 'someone-else')).ok, false);
  const waived = (await h.call(CHANNELS.packagesWaiveDependency, next, first)).data as TaskView;
  assert.deepEqual([waived.dependencies[0].waived, waived.dependencies[0].blocking], [true, false]);
  assert.equal((await h.call(CHANNELS.packagesTransition, next, 'claim')).data.status, 'in_progress');
  // Waiving is for packages not started yet.
  assert.equal((await h.call(CHANNELS.packagesWaiveDependency, next, first)).error.code, 'invalid_state');
});

test('dependencies: a finished predecessor unblocks, and done records completedAt', async () => {
  const second = { ...fixtures.PLAN_OUTPUT.packages[0], title: '接入登录路由', dependsOn: [1] };
  const h = await fixtures.harness({ agent: fixtures.fakeAgent({ plan: { ...fixtures.PLAN_OUTPUT, packages: [fixtures.PLAN_OUTPUT.packages[0], second] } }) });
  const { first, second: next } = await fixtures.publishChain(h);
  await h.store.transition(first, 'claim', 'human', { baseline: 'HEAD' });
  await h.store.transition(first, 'submit_for_review', 'human');
  await h.store.beginReview(first);
  await h.store.completeReview(first, {
    passed: true,
    reasons: [],
    evidence: [],
    checks: [],
    acceptance: [],
    report: null,
    diff: { files: [], skipped: [], outOfScope: [] },
    costUsd: 0,
  } as never);
  const done = (await h.call(CHANNELS.tasksGet, first)).data as TaskView;
  assert.equal(done.status, 'done');
  assert.ok(done.completedAt && Date.parse(done.completedAt) >= Date.parse(done.claimedAt as string));
  const unblocked = (await h.call(CHANNELS.tasksGet, next)).data as TaskView;
  assert.equal(unblocked.dependencies[0].blocking, false);
  assert.equal((await h.call(CHANNELS.packagesTransition, next, 'claim')).data.status, 'in_progress');
});
