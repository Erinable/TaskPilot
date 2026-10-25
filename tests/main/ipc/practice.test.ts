// IPC channels of the practice domain (src/main/ipc/practice.ts).
import { test, onTestFinished, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { TaskView } from '../../../src/shared/ipc_types.ts';
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

test('practice: claiming starts a reference run that stays hidden until the first submission', async () => {
  const h = await practiceHarness();
  await h.call(CHANNELS.transition, 'auth-edge-tests', 'claim', { mode: 'practice' });
  const ready = await settleTask(h.call, 'auth-edge-tests', (task) => task.referenceRun?.status === 'ready');
  assert.deepEqual(ready.referenceRun!.files, [{ path: 'tests/auth/login-user.test.ts', added: 1, removed: 1 }]);
  assert.match(h.prompts[0], /reference answer for a learner/);
  assert.equal(h.cleaned.length, 1, 'the run directory is removed; the patch is kept by TaskPilot');
  // Nothing of the patch is in the task view, and the channel refuses.
  assert.doesNotMatch(JSON.stringify(ready), /reference\(\)|test\("reference"/);
  assert.equal((await h.call(CHANNELS.referenceGet, 'auth-edge-tests')).error.code, 'reference_locked');

  await writeSubmission(h.root);
  await h.call(CHANNELS.transition, 'auth-edge-tests', 'submit_for_review');
  await fixtures.settleReview(h.call, 'auth-edge-tests');
  const revealed = await h.call(CHANNELS.referenceGet, 'auth-edge-tests');
  assert.equal(revealed.data, REFERENCE_PATCH);
  assert.ok((await h.call(CHANNELS.getTask, 'auth-edge-tests')).data.referenceRun.revealedAt);
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
