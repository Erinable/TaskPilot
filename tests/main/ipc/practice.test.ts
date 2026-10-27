// IPC channels of the practice domain (src/main/ipc/practice.ts).
import { test, onTestFinished, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { TaskView } from '../../../src/shared/ipc/packages.ts';
import { parsePatchPreview } from '../../../src/main/coding_workspace.ts';
import { CHANNELS } from '../../../src/shared/ipc_channels.ts';
import * as fixtures from './harness.ts';

// Runs real git and npm processes per test; slow machines and CI need the room.
vi.setConfig({ testTimeout: 20_000 });

// ========== practice ==========

const REFERENCE_PATCH = fixtures.filePatch('tests/auth/login-user.test.ts', 'test("reference", () => {});').patch;

// A practice harness whose reference run waits on `hold` when given.
const practiceHarness = async ({
  agent = fixtures.fakeAgent(),
  hold = null,
  failWith = null,
}: { agent?: fixtures.FakeAgent; hold?: Promise<void> | null; failWith?: Error | null } = {}) => {
  const prompts: string[] = [];
  const cleaned: string[] = [];
  const h = await fixtures.harness({
    agent,
    coding: {
      codingProbe: async () => fixtures.codingRuntime(),
      codingPrepare: async (_root, _baseline, options) => ({ runName: options!.runName!, directory: options!.runName! }),
      codingRun: async (options) => {
        prompts.push(options.prompt);
        if (hold) {
          const cancelled = () => Object.assign(new Error('Coding run was cancelled'), { code: 'coding_aborted' });
          if (options.signal?.aborted) throw cancelled();
          await Promise.race([hold, new Promise((_resolve, reject) => options.signal?.addEventListener('abort', () => reject(cancelled()), { once: true }))]);
        }
        if (failWith) throw failWith;
        return {
          output: '',
          usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: null, reasoningTokens: null, costUsd: 0.2 },
          events: [],
          sessionId: null,
        };
      },
      codingReadPatch: async (_runName, scope) => parsePatchPreview(REFERENCE_PATCH, scope),
      codingClean: async (runName) => void cleaned.push(runName),
      codingSnapshot: async (_root, baseline) => baseline,
    },
  });
  h.setCommands({ test: fixtures.EDGE_TESTS_PASS });
  return { ...h, prompts, cleaned };
};

const settleTask = async (call, id, done: (task: TaskView) => boolean) => {
  let last = '';
  for (let i = 0; i < 400; i += 1) {
    const { data } = await call(CHANNELS.getTask, id);
    last = JSON.stringify({ status: data.status, reference: data.referenceRun?.status, grade: data.grade?.status });
    if (done(data)) return data as TaskView;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`never settled: ${last}`);
};

const writeSubmission = async (root: string) => {
  await fs.mkdir(path.join(root, 'tests/auth'), { recursive: true });
  await fs.writeFile(path.join(root, 'tests/auth/login-user.test.ts'), 'test("case-insensitive", () => {});\n');
};

test('practice: claiming starts a reference run that stays hidden until the package passes its tests', async () => {
  const h = await practiceHarness();
  await h.call(CHANNELS.transition, 'auth-edge-tests', 'claim', { mode: 'practice' });
  const ready = await settleTask(h.call, 'auth-edge-tests', (task) => task.referenceRun?.status === 'ready');
  assert.deepEqual(ready.referenceRun!.files, [{ path: 'tests/auth/login-user.test.ts', added: 1, removed: 1 }]);
  assert.match(h.prompts[0], /reference answer for a learner/);
  assert.equal(h.cleaned.length, 1, 'the run directory is removed; the patch is kept by TaskPilot');
  // Nothing of the patch is in the task view, and the channel refuses.
  assert.doesNotMatch(JSON.stringify(ready), /reference\(\)|test\("reference"/);
  assert.equal((await h.call(CHANNELS.referenceGet, 'auth-edge-tests')).error.code, 'reference_locked');

  assert.deepEqual(ready.referenceLock, { unlocked: false, reason: 'not_submitted' });

  await writeSubmission(h.root);
  await h.call(CHANNELS.transition, 'auth-edge-tests', 'submit_for_review');
  await fixtures.settleReview(h.call, 'auth-edge-tests');
  assert.deepEqual((await h.call(CHANNELS.getTask, 'auth-edge-tests')).data.referenceLock, { unlocked: true, reason: 'tests_passed' });
  const revealed = await h.call(CHANNELS.referenceGet, 'auth-edge-tests');
  assert.equal(revealed.data, REFERENCE_PATCH);
  const after = (await h.call(CHANNELS.getTask, 'auth-edge-tests')).data;
  assert.ok(after.referenceRun.revealedAt);
  assert.deepEqual(after.referenceLock, { unlocked: true, reason: 'revealed' });
});

// [人工决策-2026-10-27 00:51:12] 项目 practice 包也要测试全过才解锁：提交一次但测试没全过，参考答案仍锁着。
test('practice: a submission whose tests do not all pass leaves the reference locked', async () => {
  const h = await practiceHarness();
  await h.call(CHANNELS.transition, 'auth-edge-tests', 'claim', { mode: 'practice' });
  await settleTask(h.call, 'auth-edge-tests', (task) => task.referenceRun?.status === 'ready');
  // One linked test fails.
  h.setCommands({
    test: {
      command: process.execPath,
      args: ['-e', "console.log('ok 1 - login is case-insensitive for the email\\nnot ok 2 - account locks after five failed attempts')"],
    },
  });
  await writeSubmission(h.root);
  await h.call(CHANNELS.transition, 'auth-edge-tests', 'submit_for_review');
  const reviewed = await fixtures.settleReview(h.call, 'auth-edge-tests');
  assert.equal(reviewed.review.status, 'rejected');
  const view = (await h.call(CHANNELS.getTask, 'auth-edge-tests')).data as TaskView;
  assert.deepEqual(view.referenceLock, { unlocked: false, reason: 'tests_not_passed' });
  assert.equal((await h.call(CHANNELS.referenceGet, 'auth-edge-tests')).error.code, 'reference_locked');
  assert.equal(view.referenceRun!.revealedAt, null);
});

test('practice: once QA has judged, Tutor grades against the reference without moving the package', async () => {
  const h = await practiceHarness();
  await h.call(CHANNELS.transition, 'auth-edge-tests', 'claim', { mode: 'practice' });
  await settleTask(h.call, 'auth-edge-tests', (task) => task.referenceRun?.status === 'ready');
  await writeSubmission(h.root);
  await h.call(CHANNELS.transition, 'auth-edge-tests', 'submit_for_review');
  const graded = await settleTask(h.call, 'auth-edge-tests', (task) => task.grade?.status === 'done');
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
  await h.call(CHANNELS.transition, 'auth-edge-tests', 'acceptance_rejected');
  await h.call(CHANNELS.transition, 'auth-edge-tests', 'submit_for_review');
  await fixtures.settleReview(h.call, 'auth-edge-tests');
  await h.shutdown();
  assert.equal(h.store.get('auth-edge-tests').grade!.id, graded.grade!.id);
});

test('practice: a grade waits for a reference still being written, or goes ahead when asked', async () => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = await practiceHarness({ hold });
  await h.call(CHANNELS.transition, 'auth-edge-tests', 'claim', { mode: 'practice' });
  await writeSubmission(h.root);
  await h.call(CHANNELS.transition, 'auth-edge-tests', 'submit_for_review');
  const waiting = await settleTask(h.call, 'auth-edge-tests', (task) => task.grade?.status === 'waiting');
  assert.equal(waiting.referenceRun!.status, 'running');
  release();
  const graded = await settleTask(h.call, 'auth-edge-tests', (task) => task.grade?.status === 'done');
  assert.equal(graded.grade!.withReference, true);

  const h2 = await practiceHarness({ hold: new Promise(() => {}) });
  await h2.call(CHANNELS.transition, 'auth-edge-tests', 'claim', { mode: 'practice' });
  await writeSubmission(h2.root);
  await h2.call(CHANNELS.transition, 'auth-edge-tests', 'submit_for_review');
  await settleTask(h2.call, 'auth-edge-tests', (task) => task.grade?.status === 'waiting');
  await h2.call(CHANNELS.gradeStart, 'auth-edge-tests', true);
  const alone = await settleTask(h2.call, 'auth-edge-tests', (task) => task.grade?.status === 'done');
  assert.equal(alone.grade!.withReference, false);
  assert.match(fixtures.callFor(h2.agentCalls, 'grade').prompt, /<reference_solution>\n\(none\)/);
});

test('practice: releasing cancels the reference run and clears what it would have written', async () => {
  const h = await practiceHarness({ hold: new Promise(() => {}) });
  await h.call(CHANNELS.transition, 'auth-edge-tests', 'claim', { mode: 'practice' });
  await settleTask(h.call, 'auth-edge-tests', (task) => task.referenceRun?.status === 'running');
  await h.call(CHANNELS.transition, 'auth-edge-tests', 'release');
  await h.shutdown();
  const state = h.store.get('auth-edge-tests');
  assert.equal(state.referenceRun, null);
  assert.equal(state.mode, null);
});

test('practice: a failed reference run still lets the submission be graded on its own', async () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  onTestFinished(() => errors.mockRestore());
  const h = await practiceHarness({ failWith: Object.assign(new Error('boom'), { code: 'coding_failed' }) });
  await h.call(CHANNELS.transition, 'auth-edge-tests', 'claim', { mode: 'practice' });
  await settleTask(h.call, 'auth-edge-tests', (task) => task.referenceRun?.status === 'failed');
  await writeSubmission(h.root);
  await h.call(CHANNELS.transition, 'auth-edge-tests', 'submit_for_review');
  const graded = await settleTask(h.call, 'auth-edge-tests', (task) => task.grade?.status === 'done');
  assert.equal(graded.grade!.withReference, false);
  assert.equal((await h.call(CHANNELS.referenceGet, 'auth-edge-tests')).error.code, 'no_reference');
});

test('practice: packages claimed another way get no reference and no grade', async () => {
  const h = await practiceHarness();
  await h.call(CHANNELS.transition, 'auth-edge-tests', 'claim', { mode: 'self' });
  await writeSubmission(h.root);
  await h.call(CHANNELS.transition, 'auth-edge-tests', 'submit_for_review');
  const reviewed = await fixtures.settleReview(h.call, 'auth-edge-tests');
  assert.equal(reviewed.referenceRun, null);
  assert.equal(reviewed.grade, null);
  assert.equal(h.prompts.length, 0);
  assert.equal((await h.call(CHANNELS.gradeStart, 'auth-edge-tests', false)).error.code, 'not_practice');
});

test('practice: grading reads the developer notes and keeps repeated only when there were some', async () => {
  const h = await practiceHarness();
  await h.call(CHANNELS.transition, 'auth-edge-tests', 'claim', { mode: 'practice' });
  await settleTask(h.call, 'auth-edge-tests', (task) => task.referenceRun?.status === 'ready');
  await writeSubmission(h.root);
  await h.call(CHANNELS.transition, 'auth-edge-tests', 'submit_for_review');
  const without = await settleTask(h.call, 'auth-edge-tests', (task) => task.grade?.status === 'done');
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
  await h.call(CHANNELS.gradeStart, 'auth-edge-tests', false);
  const graded = await settleTask(h.call, 'auth-edge-tests', (task) => task.grade?.status === 'done' && task.grade.id !== without.grade!.id);
  assert.equal(graded.grade!.report!.comments[0].repeated, true);
  const prompt = h.agentCalls.filter((c) => fixtures.stepOf(c.schema) === 'grade').at(-1)!.prompt;
  assert.match(prompt, /<developer_notes>\n- \[writing\] 用例要有断言: 测试必须有断言\n/, 'Tutor reads the summary, not the body');
});

test('practice: the reference run is told the referenceGuide of the course pack in use', async () => {
  const h = await practiceHarness();
  await fixtures.useOsPack(h);
  await h.call(CHANNELS.transition, 'auth-edge-tests', 'claim', { mode: 'practice' });
  await settleTask(h.call, 'auth-edge-tests', (task) => task.referenceRun?.status === 'ready');
  assert.match(h.prompts[0], /Write the complete solution to this lab step\./);
  assert.doesNotMatch(h.prompts[0], /reference answer for a learner/);
});

test('practice: grading uses the rubric of the course pack in use and snapshots it on the grade', async () => {
  const osComment = { category: 'concept', file: null, line: null, observation: '锁拿晚了。', betterWay: '先拿锁再读。', repeated: false };
  const h = await practiceHarness({ agent: fixtures.fakeAgent({ grade: { summary: '能跑。', strengths: [], comments: [osComment] } }) });
  const shown = await fixtures.useOsPack(h);
  await h.call(CHANNELS.transition, 'auth-edge-tests', 'claim', { mode: 'practice' });
  await settleTask(h.call, 'auth-edge-tests', (task) => task.referenceRun?.status === 'ready');
  await writeSubmission(h.root);
  await h.call(CHANNELS.transition, 'auth-edge-tests', 'submit_for_review');
  const graded = await settleTask(h.call, 'auth-edge-tests', (task) => task.grade?.status === 'done');
  const call = fixtures.callFor(h.agentCalls, 'grade');
  assert.match(call.systemPrompt, /- Mark two things\. concept: the model of the mechanism\. mechanism: locking and error paths\./);
  assert.deepEqual(call.schema.properties.comments.items.properties.category.enum, ['concept', 'mechanism']);
  assert.equal(graded.grade!.report!.comments[0].category, 'concept');
  assert.deepEqual(
    { ...graded.grade!.course!, rubric: graded.grade!.course!.rubric.map((item) => [item.id, item.label]) },
    {
      id: 'oslab',
      version: '0.1.0',
      contentHash: shown.contentHash,
      rubric: [
        ['concept', '原理'],
        ['mechanism', '实现'],
      ],
    },
  );
});

// [人工决策-2026-10-26 15:38:21] 内置 os 包不需要本机确认；判卷按它的三个维度输出。
test('practice: with course = "os" a grade marks concept, mechanism and safety, without confirming', async () => {
  const comments = ['concept', 'mechanism', 'safety'].map((category) => ({
    category,
    file: null,
    line: null,
    observation: '看到的。',
    betterWay: '更好的。',
    repeated: false,
  }));
  const h = await practiceHarness({ agent: fixtures.fakeAgent({ grade: { summary: '能跑。', strengths: [], comments } }) });
  await fs.writeFile(path.join(h.root, 'taskpilot.toml'), 'course = "os"\n');
  await h.call(CHANNELS.transition, 'auth-edge-tests', 'claim', { mode: 'practice' });
  await settleTask(h.call, 'auth-edge-tests', (task) => task.referenceRun?.status === 'ready');
  await writeSubmission(h.root);
  await h.call(CHANNELS.transition, 'auth-edge-tests', 'submit_for_review');
  const graded = await settleTask(h.call, 'auth-edge-tests', (task) => task.grade?.status === 'done');
  const call = fixtures.callFor(h.agentCalls, 'grade');
  assert.deepEqual(call.schema.properties.comments.items.properties.category.enum, ['concept', 'mechanism', 'safety']);
  assert.match(call.systemPrompt, /a student learning operating systems who can already write basic C practises real work packages/);
  assert.match(call.systemPrompt, /\n {2}- Example for concept: what was seen "在 trap 处理中直接读用户指针"/);
  assert.deepEqual(
    graded.grade!.report!.comments.map((comment) => comment.category),
    ['concept', 'mechanism', 'safety'],
  );
  assert.equal(graded.grade!.course!.id, 'os');
  assert.deepEqual(
    graded.grade!.course!.rubric.map((item) => [item.id, item.label, item.dimension]),
    [
      ['concept', '原理', 'thinking'],
      ['mechanism', '实现', 'writing'],
      ['safety', '并发与安全', 'style'],
    ],
  );
});

test('practice: grading an OS package reads OS notes first, then other packs on a dimension OS has', async () => {
  const osComment = { category: 'concept', file: null, line: null, observation: '锁拿晚了。', betterWay: '先拿锁再读。', repeated: false };
  const h = await practiceHarness({ agent: fixtures.fakeAgent({ grade: { summary: '能跑。', strengths: [], comments: [osComment] } }) });
  await fixtures.useOsPack(h);
  await h.notes.create({ title: '先拆问题', body: '先拆', category: 'thinking', tags: [], source: null });
  await h.notes.create({ title: '命名要完整', body: '命名', category: 'style', tags: [], source: null });
  await h.notes.create({ title: '锁的顺序', body: '先拿锁', category: 'concept', course: 'oslab', tags: [], source: null });
  await h.call(CHANNELS.transition, 'auth-edge-tests', 'claim', { mode: 'practice' });
  await settleTask(h.call, 'auth-edge-tests', (task) => task.referenceRun?.status === 'ready');
  await writeSubmission(h.root);
  await h.call(CHANNELS.transition, 'auth-edge-tests', 'submit_for_review');
  await settleTask(h.call, 'auth-edge-tests', (task) => task.grade?.status === 'done');
  const prompt = fixtures.callFor(h.agentCalls, 'grade').prompt;
  // style is not a dimension the OS rubric has.
  assert.match(prompt, /<developer_notes>\n- \[concept\] 锁的顺序: 先拿锁\n- \[thinking\] 先拆问题: 先拆\n<\/developer_notes>/);
});

test('practice: a grade whose category is not in the pack in use fails instead of being kept', async () => {
  // The default fake answers with programming categories (writing, style).
  const h = await practiceHarness();
  await fixtures.useOsPack(h);
  await h.call(CHANNELS.transition, 'auth-edge-tests', 'claim', { mode: 'practice' });
  await settleTask(h.call, 'auth-edge-tests', (task) => task.referenceRun?.status === 'ready');
  await writeSubmission(h.root);
  await h.call(CHANNELS.transition, 'auth-edge-tests', 'submit_for_review');
  const failed = await settleTask(h.call, 'auth-edge-tests', (task) => task.grade?.status === 'failed');
  assert.equal(failed.grade!.error!.code, 'agent_bad_output');
  assert.match(failed.grade!.error!.message, /comments\[0\]\.category must be one of concept, mechanism/);
});

test('practice: an unconfirmed repository pack is graded with programming', async () => {
  const h = await practiceHarness();
  await fixtures.useOsPack(h, { confirm: false });
  await h.call(CHANNELS.transition, 'auth-edge-tests', 'claim', { mode: 'practice' });
  await settleTask(h.call, 'auth-edge-tests', (task) => task.referenceRun?.status === 'ready');
  await writeSubmission(h.root);
  await h.call(CHANNELS.transition, 'auth-edge-tests', 'submit_for_review');
  const graded = await settleTask(h.call, 'auth-edge-tests', (task) => task.grade?.status === 'done');
  assert.equal(graded.grade!.course!.id, 'programming');
  assert.deepEqual(fixtures.callFor(h.agentCalls, 'grade').schema.properties.comments.items.properties.category.enum, ['thinking', 'writing', 'style']);
});

// [人工决策-2026-10-27 00:36:21] 用 os 包规划的项目任务带上骨架里的知识点，判卷后按知识点写掌握度。
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
  const h = await practiceHarness({ agent: fixtures.fakeAgent({ plan, grade }) });
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
  assert.deepEqual((await h.call(CHANNELS.getTask, id)).data.concepts, ['round-robin', 'priority-sched']);

  h.setCommands({ test: { command: process.execPath, args: ['-e', "console.log('ok 1 - login succeeds')"] } });
  await h.call(CHANNELS.transition, id, 'claim', { mode: 'practice' });
  await settleTask(h.call, id, (task) => task.referenceRun?.status === 'ready');
  await fs.writeFile(path.join(h.root, 'src/auth/application/login-user.ts'), 'export const login = () => true;\n');
  await h.call(CHANNELS.transition, id, 'submit_for_review');
  const graded = await settleTask(h.call, id, (task) => task.grade?.status === 'done');
  assert.deepEqual(graded.grade!.report!.errorTags, ['off-by-one']);
  // Mastery is written right after the grade is stored.
  for (let i = 0; i < 400 && !h.mastery.get('os', 'round-robin'); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  const record = h.mastery.get('os', 'round-robin')!;
  assert.deepEqual(
    record.attempts.map((attempt) => [attempt.packageId, attempt.repoId, attempt.result, attempt.errorTypes]),
    [[id, h.repositories.current!.id, 'pass', ['mechanism', 'off-by-one']]],
  );
  assert.equal(h.mastery.get('os', 'priority-sched')!.totals.attempts, 1);

  // Regrading the same submission writes nothing more.
  await h.call(CHANNELS.gradeStart, id, false);
  await h.call(CHANNELS.gradeStart, id, true);
  await settleTask(h.call, id, (task) => task.grade?.status === 'done' && task.grade.id !== graded.grade!.id);
  await h.shutdown();
  assert.equal(h.mastery.get('os', 'round-robin')!.totals.attempts, 1);
});

test('practice: a package without concepts writes no mastery', async () => {
  const h = await practiceHarness();
  await h.call(CHANNELS.transition, 'auth-edge-tests', 'claim', { mode: 'practice' });
  await settleTask(h.call, 'auth-edge-tests', (task) => task.referenceRun?.status === 'ready');
  await writeSubmission(h.root);
  await h.call(CHANNELS.transition, 'auth-edge-tests', 'submit_for_review');
  await settleTask(h.call, 'auth-edge-tests', (task) => task.grade?.status === 'done');
  await h.shutdown();
  assert.deepEqual(h.mastery.list(), []);
});
