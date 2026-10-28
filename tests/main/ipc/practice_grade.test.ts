// IPC channels for packages and practice service (src/main/ipc/packages.ts, src/main/work_packages/practice_service.ts).
import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { TaskView } from '../../../src/shared/ipc/packages.ts';
import { CHANNELS } from '../../../src/shared/ipc_channels.ts';
import * as fixtures from './harness.ts';
import * as practice from './practice_fixtures.ts';
import { captureExpectedErrors } from '../../fixtures/expected_errors.ts';

// Runs real git and npm processes per test; slow machines and CI need the room.
vi.setConfig({ testTimeout: 20_000 });

// ========== practice ==========

test('practice: a project package planned with the os pack carries its concepts, and its grade writes mastery once', async () => {
  const plan = {
    ...fixtures.PLAN_OUTPUT,
    packages: [{ ...fixtures.PLAN_OUTPUT.packages[0], concepts: ['round-robin', 'made-up', 'priority-sched'] }],
  };
  const grade = {
    summary: '能跑。',
    strengths: [],
    comments: [{ category: 'mechanism', file: null, line: null, observation: '时间片没重置。', betterWay: '切换时重置。', repeated: false }],
    errorTags: ['off-by-one', 'Bad Tag'],
  };
  const h = await practice.practiceHarness({ agent: fixtures.fakeAgent({ plan, grade }) });
  await fs.writeFile(path.join(h.root, 'taskpilot.toml'), 'course = "os"\n');
  const created = await h.call(CHANNELS.requirementsCreate, { text: '给调度器加时间片轮转' });
  await fixtures.settle(h.call, created.data.id);
  await h.call(CHANNELS.requirementsPlan, created.data.id, ['5 次']);
  const planned = await fixtures.settle(h.call, created.data.id);
  const planCall = fixtures.callFor(h.agentCalls, 'plan');
  assert.ok(planCall.prompt.includes('\n- round-robin: '), 'the skeleton is offered');
  assert.ok(planCall.schema.properties.packages.items.properties.concepts.items.enum.includes('round-robin'));
  assert.deepEqual(planned.plan.packages[0].concepts, ['round-robin', 'priority-sched'], 'ids outside the skeleton are dropped');
  await h.call(CHANNELS.requirementsPublish, created.data.id);
  const id = `${created.data.id}-wp1`;
  assert.deepEqual((await h.call(CHANNELS.tasksGet, id)).data.concepts, ['round-robin', 'priority-sched']);

  h.setCommands({ test: { command: process.execPath, args: ['-e', "console.log('ok 1 - login succeeds')"] } });
  await h.call(CHANNELS.packagesTransition, id, 'claim', { mode: 'practice' });
  await practice.settleTask(h.call, id, (task) => task.referenceRun?.status === 'ready');
  await fs.writeFile(path.join(h.root, 'src/auth/application/login-user.ts'), 'export const login = () => true;\n');
  await h.call(CHANNELS.packagesTransition, id, 'submit_for_review');
  const graded = await practice.settleTask(h.call, id, (task) => task.grade?.status === 'done');
  assert.deepEqual(graded.grade!.report!.errorTags, ['off-by-one']);
  // Mastery is written after the grade is stored and the run is idle.
  await h.idle();
  const record = h.mastery.get('os', 'round-robin')!;
  assert.deepEqual(
    record.attempts.map((attempt) => [attempt.packageId, attempt.repoId, attempt.result, attempt.errorTypes]),
    [[id, h.repositories.current!.id, 'pass', ['mechanism', 'off-by-one']]],
  );
  assert.equal(h.mastery.get('os', 'priority-sched')!.totals.attempts, 1);

  // Regrading the same submission writes nothing more.
  await h.call(CHANNELS.practiceGrade, id, false);
  await h.call(CHANNELS.practiceGrade, id, true);
  await practice.settleTask(h.call, id, (task) => task.grade?.status === 'done' && task.grade.id !== graded.grade!.id);
  await h.shutdown();
  assert.equal(h.mastery.get('os', 'round-robin')!.totals.attempts, 1);
});

test('practice: a package without concepts writes no mastery', async () => {
  const h = await practice.practiceHarness();
  await h.call(CHANNELS.packagesTransition, 'auth-edge-tests', 'claim', { mode: 'practice' });
  await practice.settleTask(h.call, 'auth-edge-tests', (task) => task.referenceRun?.status === 'ready');
  await practice.writeSubmission(h.root);
  await h.call(CHANNELS.packagesTransition, 'auth-edge-tests', 'submit_for_review');
  await practice.settleTask(h.call, 'auth-edge-tests', (task) => task.grade?.status === 'done');
  await h.shutdown();
  assert.deepEqual(h.mastery.list(), []);
});

// [人工决策-2026-10-27 00:36:21] 判卷写入 Grade.scores：分数由 TaskPilot 算，模型只给 rubric 的 levels。
test('practice: explaining the differences: Tutor picks them, answers get one reply, and it is saved as a note', async () => {
  const h = await practice.gradedWithReference();
  const before = (await h.call(CHANNELS.tasksGet, 'auth-edge-tests')).data as TaskView;
  const scores = before.grade!.scores;
  await h.call(CHANNELS.practiceExplain, 'auth-edge-tests');
  const picked = await practice.settleExplanation(h, 'answering');
  const pickCall = fixtures.callFor(h.agentCalls, 'differences');
  assert.match(pickCall.prompt, /<reference_solution>\ndiff --git/);
  assert.deepEqual(pickCall.schema.properties.differences.items.properties.category.enum, ['thinking', 'writing', 'style']);
  assert.deepEqual(
    picked.grade!.explanation!.items.map((item) => [item.category, item.file, item.answer]),
    [
      ['thinking', 'tests/auth/login-user.test.ts', null],
      // Not a file the reference changes.
      ['writing', null, null],
    ],
  );
  assert.equal((await h.call(CHANNELS.practiceExplain, 'auth-edge-tests')).error.code, 'invalid_state');
  assert.equal((await h.call(CHANNELS.practiceAnswer, 'auth-edge-tests', ['只有一条'])).error.code, 'invalid_argument');

  // The second is skipped: only the first reaches Tutor.
  await h.call(CHANNELS.practiceAnswer, 'auth-edge-tests', ['先让测试失败，才能确认它测到了东西。', '  ']);
  const done = await practice.settleExplanation(h, 'done');
  const feedbackCall = fixtures.callFor(h.agentCalls, 'feedback');
  assert.equal(feedbackCall.schema.properties.replies.minItems, 1);
  assert.match(feedbackCall.prompt, /Why, in the developer’s words: 先让测试失败/);
  assert.doesNotMatch(feedbackCall.prompt, /index="1"/);
  const explanation = done.grade!.explanation!;
  assert.deepEqual(
    explanation.items.map((item) => [item.answer, item.feedback]),
    [
      ['先让测试失败，才能确认它测到了东西。', { correct: true, missed: null }],
      [null, null],
    ],
  );
  assert.equal(explanation.completed, true);
  // Explaining counts towards neither score.
  assert.deepEqual(done.grade!.scores, scores);
  assert.doesNotMatch(JSON.stringify(done), /test\("reference"/, 'the reference itself never reaches the renderer');

  await h.call(CHANNELS.practiceSaveExplanation, 'auth-edge-tests');
  const saved = (await h.call(CHANNELS.tasksGet, 'auth-edge-tests')).data as TaskView;
  const noteId = saved.grade!.explanation!.noteId!;
  const note = h.notes.get(noteId);
  assert.equal(note.title, '参考实现为什么这样做：补充登录模块边界测试');
  assert.equal(note.category, 'thinking');
  assert.equal(note.course, 'programming');
  assert.equal(note.source!.packageId, 'auth-edge-tests');
  assert.match(note.body, /## 1\. 参考实现先写了一个会失败的用例。[\s\S]*我的解释：先让测试失败[\s\S]*导师：对。[\s\S]*我的解释：（跳过）/);
  // Saving again keeps the one note.
  await h.call(CHANNELS.practiceSaveExplanation, 'auth-edge-tests');
  assert.equal(h.notes.list().notes.length, 1);
});

test('practice: skipping every difference ends the explanation without a reply and not completed', async () => {
  const h = await practice.gradedWithReference();
  await h.call(CHANNELS.practiceExplain, 'auth-edge-tests');
  await practice.settleExplanation(h, 'answering');
  const done = (await h.call(CHANNELS.practiceAnswer, 'auth-edge-tests', [null, ''])).data as TaskView;
  assert.equal(done.grade!.explanation!.status, 'done');
  assert.equal(done.grade!.explanation!.completed, false);
  assert.equal(fixtures.callFor(h.agentCalls, 'feedback'), undefined);
});

test('practice: a failed reply keeps the answers and can be asked again', async () => {
  captureExpectedErrors((error) => error.message === 'model down');
  const h = await practice.gradedWithReference(fixtures.fakeAgent({ feedback: new Error('model down') }));
  await h.call(CHANNELS.practiceExplain, 'auth-edge-tests');
  await practice.settleExplanation(h, 'answering');
  await h.call(CHANNELS.practiceAnswer, 'auth-edge-tests', ['一', '二']);
  const failed = await practice.settleExplanation(h, 'failed');
  assert.deepEqual(
    failed.grade!.explanation!.items.map((item) => item.answer),
    ['一', '二'],
  );
  assert.equal(failed.grade!.explanation!.completed, false);
  assert.equal((await h.call(CHANNELS.practiceSaveExplanation, 'auth-edge-tests')).error.code, 'invalid_state');
});

test('practice: explaining needs a grade made with the reference, and the reference unlocked', async () => {
  const h = await practice.practiceHarness();
  await h.call(CHANNELS.packagesTransition, 'auth-edge-tests', 'claim', { mode: 'practice' });
  await practice.settleTask(h.call, 'auth-edge-tests', (task) => task.referenceRun?.status === 'ready');
  assert.equal((await h.call(CHANNELS.practiceExplain, 'auth-edge-tests')).error.code, 'grade_not_done');
  h.setCommands({
    test: {
      command: process.execPath,
      args: ['-e', "console.log('ok 1 - login is case-insensitive for the email\\nnot ok 2 - account locks after five failed attempts')"],
    },
  });
  await practice.writeSubmission(h.root);
  await h.call(CHANNELS.packagesTransition, 'auth-edge-tests', 'submit_for_review');
  await practice.settleTask(h.call, 'auth-edge-tests', (task) => task.grade?.status === 'done');
  assert.equal((await h.call(CHANNELS.practiceExplain, 'auth-edge-tests')).error.code, 'reference_locked');
});
