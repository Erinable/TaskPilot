/** @module-tag integration */
// IPC channels for packages and practice service (src/main/ipc/packages.ts, src/main/work_packages/practice_service.ts).
import { test } from 'vitest';
import assert from 'node:assert/strict';

import type { TaskView } from '../../../src/shared/ipc/packages.ts';
import { CHANNELS } from '../../../src/shared/ipc_channels.ts';
import * as fixtures from './harness.ts';
import * as practice from './practice_fixtures.ts';
import { captureExpectedErrors } from '../../fixtures/expected_errors.ts';

// ========== practice ==========

test('practice: claiming starts a reference run that stays hidden until the package passes its tests', async () => {
  const h = await practice.practiceHarness();
  await h.call(CHANNELS.packagesTransition, 'auth-edge-tests', 'claim', { mode: 'practice' });
  const ready = await practice.settleTask(h.call, 'auth-edge-tests', (task) => task.referenceRun?.status === 'ready');
  assert.deepEqual(ready.referenceRun!.files, [{ path: 'tests/auth/login-user.test.ts', added: 1, removed: 1 }]);
  assert.match(h.prompts[0], /reference answer for a learner/);
  assert.equal(h.cleaned.length, 1, 'the run directory is removed; the patch is kept by TaskPilot');
  // Nothing of the patch is in the task view, and the channel refuses.
  assert.doesNotMatch(JSON.stringify(ready), /reference\(\)|test\("reference"/);
  assert.equal((await h.call(CHANNELS.practiceReference, 'auth-edge-tests')).error.code, 'reference_locked');

  assert.deepEqual(ready.referenceLock, { unlocked: false, reason: 'not_submitted' });

  await practice.writeSubmission(h.root);
  await h.call(CHANNELS.packagesTransition, 'auth-edge-tests', 'submit_for_review');
  await fixtures.settleReview(h.call, 'auth-edge-tests');
  assert.deepEqual((await h.call(CHANNELS.tasksGet, 'auth-edge-tests')).data.referenceLock, { unlocked: true, reason: 'tests_passed' });
  const revealed = await h.call(CHANNELS.practiceReference, 'auth-edge-tests');
  assert.equal(revealed.data, practice.REFERENCE_PATCH);
  const after = (await h.call(CHANNELS.tasksGet, 'auth-edge-tests')).data;
  assert.ok(after.referenceRun.revealedAt);
  assert.deepEqual(after.referenceLock, { unlocked: true, reason: 'revealed' });
});

// [人工决策-2026-10-27 00:51:12] 项目 practice 包也要测试全过才解锁：提交一次但测试没全过，参考答案仍锁着。
test('practice: a submission whose tests do not all pass leaves the reference locked', async () => {
  const h = await practice.practiceHarness();
  await h.call(CHANNELS.packagesTransition, 'auth-edge-tests', 'claim', { mode: 'practice' });
  await practice.settleTask(h.call, 'auth-edge-tests', (task) => task.referenceRun?.status === 'ready');
  // One linked test fails.
  h.setCommands({
    test: {
      command: process.execPath,
      args: ['-e', "console.log('ok 1 - login is case-insensitive for the email\\nnot ok 2 - account locks after five failed attempts')"],
    },
  });
  await practice.writeSubmission(h.root);
  await h.call(CHANNELS.packagesTransition, 'auth-edge-tests', 'submit_for_review');
  const reviewed = await fixtures.settleReview(h.call, 'auth-edge-tests');
  assert.equal(reviewed.review.status, 'rejected');
  const view = (await h.call(CHANNELS.tasksGet, 'auth-edge-tests')).data as TaskView;
  assert.deepEqual(view.referenceLock, { unlocked: false, reason: 'tests_not_passed' });
  assert.equal((await h.call(CHANNELS.practiceReference, 'auth-edge-tests')).error.code, 'reference_locked');
  assert.equal(view.referenceRun!.revealedAt, null);
});

test('practice: once QA has judged, Tutor grades against the reference without moving the package', async () => {
  const h = await practice.practiceHarness();
  await h.call(CHANNELS.packagesTransition, 'auth-edge-tests', 'claim', { mode: 'practice' });
  await practice.settleTask(h.call, 'auth-edge-tests', (task) => task.referenceRun?.status === 'ready');
  await practice.writeSubmission(h.root);
  await h.call(CHANNELS.packagesTransition, 'auth-edge-tests', 'submit_for_review');
  const graded = await practice.settleTask(h.call, 'auth-edge-tests', (task) => task.grade?.status === 'done');
  assert.equal(graded.status, 'accepting', 'grading never changes the status QA set');
  assert.equal(graded.grade!.withReference, true);
  assert.equal(graded.grade!.report!.comments[0].file, 'tests/auth/login-user.test.ts');
  // A comment on a file the developer did not touch keeps its text, not the location.
  assert.equal(graded.grade!.report!.comments[1].file, null);
  const prompt = fixtures.callFor(h.agentCalls, 'grade').prompt;
  assert.match(prompt, /<submission>\n<file path="tests\/auth\/login-user\.test\.ts">/);
  assert.match(prompt, /<reference_solution>\ndiff --git/);
  assert.match(prompt, /Verdict: accepted/);

  // The same submission is not graded again.
  await h.call(CHANNELS.packagesTransition, 'auth-edge-tests', 'acceptance_rejected');
  await h.call(CHANNELS.packagesTransition, 'auth-edge-tests', 'submit_for_review');
  await fixtures.settleReview(h.call, 'auth-edge-tests');
  await h.shutdown();
  assert.equal(h.store.get('auth-edge-tests').grade!.id, graded.grade!.id);
});

test('practice: a grade waits for a reference still being written, or goes ahead when asked', async () => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = await practice.practiceHarness({ hold });
  await h.call(CHANNELS.packagesTransition, 'auth-edge-tests', 'claim', { mode: 'practice' });
  await practice.writeSubmission(h.root);
  await h.call(CHANNELS.packagesTransition, 'auth-edge-tests', 'submit_for_review');
  const waiting = await practice.settleTask(h.call, 'auth-edge-tests', (task) => task.grade?.status === 'waiting');
  assert.equal(waiting.referenceRun!.status, 'running');
  release();
  const graded = await practice.settleTask(h.call, 'auth-edge-tests', (task) => task.grade?.status === 'done');
  assert.equal(graded.grade!.withReference, true);

  const h2 = await practice.practiceHarness({ hold: new Promise(() => {}) });
  await h2.call(CHANNELS.packagesTransition, 'auth-edge-tests', 'claim', { mode: 'practice' });
  await practice.writeSubmission(h2.root);
  await h2.call(CHANNELS.packagesTransition, 'auth-edge-tests', 'submit_for_review');
  await practice.settleTask(h2.call, 'auth-edge-tests', (task) => task.grade?.status === 'waiting');
  await h2.call(CHANNELS.practiceGrade, 'auth-edge-tests', true);
  const alone = await practice.settleTask(h2.call, 'auth-edge-tests', (task) => task.grade?.status === 'done');
  assert.equal(alone.grade!.withReference, false);
  assert.match(fixtures.callFor(h2.agentCalls, 'grade').prompt, /<reference_solution>\n\(none\)/);
});

test('practice: releasing cancels the reference run and clears what it would have written', async () => {
  const h = await practice.practiceHarness({ hold: new Promise(() => {}) });
  await h.call(CHANNELS.packagesTransition, 'auth-edge-tests', 'claim', { mode: 'practice' });
  await practice.settleTask(h.call, 'auth-edge-tests', (task) => task.referenceRun?.status === 'running');
  await h.call(CHANNELS.packagesTransition, 'auth-edge-tests', 'release');
  await h.shutdown();
  const state = h.store.get('auth-edge-tests');
  assert.equal(state.referenceRun, null);
  assert.equal(state.mode, null);
});

test('practice: a failed reference run still lets the submission be graded on its own', async () => {
  captureExpectedErrors((error) => 'code' in error && error.code === 'coding_failed' && error.message === 'boom');
  const h = await practice.practiceHarness({ failWith: Object.assign(new Error('boom'), { code: 'coding_failed' }) });
  await h.call(CHANNELS.packagesTransition, 'auth-edge-tests', 'claim', { mode: 'practice' });
  await practice.settleTask(h.call, 'auth-edge-tests', (task) => task.referenceRun?.status === 'failed');
  await practice.writeSubmission(h.root);
  await h.call(CHANNELS.packagesTransition, 'auth-edge-tests', 'submit_for_review');
  const graded = await practice.settleTask(h.call, 'auth-edge-tests', (task) => task.grade?.status === 'done');
  assert.equal(graded.grade!.withReference, false);
  assert.equal((await h.call(CHANNELS.practiceReference, 'auth-edge-tests')).error.code, 'no_reference');
});

test('practice: packages claimed another way get no reference and no grade', async () => {
  const h = await practice.practiceHarness();
  await h.call(CHANNELS.packagesTransition, 'auth-edge-tests', 'claim', { mode: 'self' });
  await practice.writeSubmission(h.root);
  await h.call(CHANNELS.packagesTransition, 'auth-edge-tests', 'submit_for_review');
  const reviewed = await fixtures.settleReview(h.call, 'auth-edge-tests');
  assert.equal(reviewed.referenceRun, null);
  assert.equal(reviewed.grade, null);
  assert.equal(h.prompts.length, 0);
  assert.equal((await h.call(CHANNELS.practiceGrade, 'auth-edge-tests', false)).error.code, 'not_practice');
});

test('practice: grading reads the developer notes and keeps repeated only when there were some', async () => {
  const h = await practice.practiceHarness();
  await h.call(CHANNELS.packagesTransition, 'auth-edge-tests', 'claim', { mode: 'practice' });
  await practice.settleTask(h.call, 'auth-edge-tests', (task) => task.referenceRun?.status === 'ready');
  await practice.writeSubmission(h.root);
  await h.call(CHANNELS.packagesTransition, 'auth-edge-tests', 'submit_for_review');
  const without = await practice.settleTask(h.call, 'auth-edge-tests', (task) => task.grade?.status === 'done');
  assert.equal(without.grade!.report!.comments[0].repeated, false, 'nothing can repeat with no notes');
  assert.match(fixtures.callFor(h.agentCalls, 'grade').prompt, /<developer_notes>\n\(none\)/);

  const { note } = await h.notes.create({
    title: '用例要有断言',
    body: '没有 expect 的测试什么也证明不了，一大段正文',
    category: 'writing',
    tags: [],
    source: null,
  });
  await h.notes.setSummary(note.id, '测试必须有断言', note.version);
  await h.call(CHANNELS.practiceGrade, 'auth-edge-tests', false);
  const graded = await practice.settleTask(h.call, 'auth-edge-tests', (task) => task.grade?.status === 'done' && task.grade.id !== without.grade!.id);
  assert.equal(graded.grade!.report!.comments[0].repeated, true);
  const prompt = h.agentCalls.filter((c) => fixtures.stepOf(c.schema) === 'grade').at(-1)!.prompt;
  assert.match(prompt, /<developer_notes>\n- \[writing\] 用例要有断言: 测试必须有断言\n/, 'Tutor reads the summary, not the body');
});

test('practice: a grade whose category is not in the pack in use fails instead of being kept', async () => {
  captureExpectedErrors((error) => 'code' in error && error.code === 'agent_bad_output' && error.message.startsWith('comments[0].category '));
  const malformed = {
    summary: '不合规。',
    strengths: [],
    comments: [{ category: 'writing', file: null, line: null, observation: '错误类别。', betterWay: '改正。', repeated: false }],
  };
  const h = await practice.practiceHarness({ agent: fixtures.fakeAgent({ grade: malformed }) });
  await fixtures.useOsPack(h);
  await h.call(CHANNELS.packagesTransition, 'auth-edge-tests', 'claim', { mode: 'practice' });
  await practice.settleTask(h.call, 'auth-edge-tests', (task) => task.referenceRun?.status === 'ready');
  await practice.writeSubmission(h.root);
  await h.call(CHANNELS.packagesTransition, 'auth-edge-tests', 'submit_for_review');
  const failed = await practice.settleTask(h.call, 'auth-edge-tests', (task) => task.grade?.status === 'failed');
  assert.equal(failed.grade!.error!.code, 'agent_bad_output');
  assert.match(failed.grade!.error!.message, /comments\[0\]\.category must be one of concept, mechanism/);
});

test('practice: an unconfirmed repository pack is graded with programming', async () => {
  const h = await practice.practiceHarness();
  await fixtures.useOsPack(h, { confirm: false });
  await h.call(CHANNELS.packagesTransition, 'auth-edge-tests', 'claim', { mode: 'practice' });
  await practice.settleTask(h.call, 'auth-edge-tests', (task) => task.referenceRun?.status === 'ready');
  await practice.writeSubmission(h.root);
  await h.call(CHANNELS.packagesTransition, 'auth-edge-tests', 'submit_for_review');
  const graded = await practice.settleTask(h.call, 'auth-edge-tests', (task) => task.grade?.status === 'done');
  assert.equal(graded.grade!.course!.id, 'programming');
  assert.deepEqual(fixtures.callFor(h.agentCalls, 'grade').schema.properties.comments.items.properties.category.enum, ['thinking', 'writing', 'style']);
});

test('practice: the confirmed course guide and rubric reach reference and grading agents', async () => {
  const grade = {
    summary: '能跑。',
    strengths: [],
    comments: [{ category: 'concept', file: null, line: null, observation: '机制。', betterWay: '改进。', repeated: false }],
  };
  const h = await practice.practiceHarness({ agent: fixtures.fakeAgent({ grade }) });
  const shown = await fixtures.useOsPack(h);
  await h.call(CHANNELS.packagesTransition, 'auth-edge-tests', 'claim', { mode: 'practice' });
  await practice.settleTask(h.call, 'auth-edge-tests', (task) => task.referenceRun?.status === 'ready');
  assert.match(h.prompts[0], /Write the complete solution to this lab step/);
  await practice.writeSubmission(h.root);
  await h.call(CHANNELS.packagesTransition, 'auth-edge-tests', 'submit_for_review');
  const graded = await practice.settleTask(h.call, 'auth-edge-tests', (task) => task.grade?.status === 'done');
  const gradeCall = fixtures.callFor(h.agentCalls, 'grade');
  assert.deepEqual(gradeCall.schema.properties.comments.items.properties.category.enum, ['concept', 'mechanism']);
  assert.equal(graded.grade!.course!.contentHash, shown.contentHash);
});

// [人工决策-2026-10-27 00:36:21] 用 os 包规划的项目任务带上骨架里的知识点，判卷后按知识点写掌握度。
