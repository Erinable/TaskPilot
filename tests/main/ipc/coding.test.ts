// IPC channels of the coding domain (src/main/ipc/coding.ts).
import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { CodingExecError } from '../../../src/main/coding/coding_process.ts';
import { CHANNELS } from '../../../src/shared/ipc_channels.ts';
import { SAMPLE_TASKS } from '../fixtures/sample_tasks.ts';
import * as fixtures from './harness.ts';
import * as coding from './coding_fixtures.ts';

// Runs real git and npm processes per test; slow machines and CI need the room.
vi.setConfig({ testTimeout: 20_000 });

test('coding shutdown aborts an active run and waits for its settled write', async () => {
  let aborted = false;
  let finish: (() => void) | null = null;
  let markStarted: (() => void) | null = null;
  const runStarted = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const h = await fixtures.harness({
    seedState: {
      'auth-edge-tests': { status: 'in_progress', baseline: 'HEAD', claimedAt: new Date().toISOString(), completedSteps: [], deviations: [], review: null },
    },
    coding: {
      codingProbe: async () => fixtures.codingRuntime(),
      codingPrepare: async (_root, _baseline, options) => ({ runName: options!.runName!, directory: options!.runName! }),
      codingRun: async (options) => {
        markStarted?.();
        options.signal!.addEventListener('abort', () => {
          aborted = true;
          finish?.();
        });
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        throw Object.assign(new Error('cancelled'), { code: 'coding_aborted' });
      },
      codingClean: async () => {},
    },
  });
  await h.call(CHANNELS.codingStart, 'auth-edge-tests', { instruction: '等待取消' });
  await runStarted;
  await h.shutdown();
  assert.equal(aborted, true);
  assert.equal((await h.call(CHANNELS.codingGet, 'auth-edge-tests')).data.codingRun?.status, 'cancelled');
});

// A coding harness for auth-email-login, in progress at the repository's
// HEAD. Each round's fake agent edits login-user.ts; applying writes it.
test('coding: a practised package keeps Coding Agent out', async () => {
  const h = await coding.loopHarness();
  await h.store.transition('auth-email-login', 'release', 'human');
  const head = (await fixtures.run('git', ['rev-parse', 'HEAD'], { cwd: h.root })).stdout.trim();
  await h.store.transition('auth-email-login', 'claim', 'human', { baseline: head, mode: 'practice' });
  const refused = await h.call(CHANNELS.codingStart, 'auth-email-login', { instruction: '实现登录' });
  assert.equal(refused.error.code, 'practice_mode');
  assert.equal(h.prompts.length, 0);
});

test('coding: the prompt lists steps and the exact names of linked tests', async () => {
  const h = await coding.loopHarness();
  await h.call(CHANNELS.codingStart, 'auth-email-login', { instruction: '实现登录' });
  await fixtures.settleCoding(h.call, 'auth-email-login');
  assert.match(h.prompts[0], /Steps:\n1\. /);
  assert.match(h.prompts[0], /- 成功返回 token，不暴露用户是否存在 \(proved by a test named exactly "login succeeds with valid credentials"\)/);
});

test('coding: a planned package hands Coding Agent the Architect summary', async () => {
  const h = await coding.loopHarness({ agent: fixtures.fakeAgent() });
  const created = await h.call(CHANNELS.requirementsCreate, { text: '用户可以用邮箱登录' });
  await fixtures.settle(h.call, created.data.id);
  await h.call(CHANNELS.requirementsPlan, created.data.id, ['5 次']);
  await fixtures.settle(h.call, created.data.id);
  await h.call(CHANNELS.requirementsPublish, created.data.id);
  const id = `${created.data.id}-wp1`;
  await h.call(CHANNELS.packagesTransition, id, 'claim', { mode: 'ai' });
  await h.call(CHANNELS.codingStart, id, { instruction: '实现登录' });
  await fixtures.settleCoding(h.call, id);
  assert.match(h.prompts[0], /<interface_summary author="Architect">\nsrc\/auth\/application\/login-user\.ts: 登录用例占位/);
});

test('coding loop: failing checks go back to the agent until three automatic rounds are used', async () => {
  const h = await coding.loopHarness();
  h.setCommands({ test: coding.LOGIN_TESTS_FAIL });
  assert.equal((await coding.applyFirstRound(h)).ok, true);
  const task = await coding.settleLoop(h.call, 'auth-email-login', (view) => view.codingRun?.halt === 'attempts_exhausted');
  assert.equal(task.status, 'in_progress');
  assert.equal(task.codingRun?.status, 'applied');
  assert.equal(task.codingRun?.attempt, 4);
  assert.deepEqual(
    task.codingRun?.rounds.map((round) => [round.attempt, round.trigger]),
    [
      [1, 'human'],
      [2, 'checks_failed'],
      [3, 'checks_failed'],
    ],
  );
  assert.equal(h.prompts.length, 4);
  assert.doesNotMatch(h.prompts[0], /submit checks failed/);
  assert.match(h.prompts[1], /submit checks failed[\s\S]*login succeeds with valid credentials/);
  // The last automatic round's patch is in the working tree.
  assert.equal(await fs.readFile(path.join(h.root, h.file), 'utf8'), 'export const round = 4;\n');
});

test('coding loop: passing checks submit to QA, and a rejection starts the next round', async () => {
  let reviews = 0;
  const h = await coding.loopHarness({
    agent: async (options) => {
      if (fixtures.stepOf(options.schema) !== 'review') return fixtures.fakeAgent()(options);
      reviews += 1;
      const review =
        reviews === 1
          ? {
              ...fixtures.QA_PASS,
              verdict: 'reject',
              issues: [{ severity: 'major', text: '没有处理空密码', file: 'src/auth/application/login-user.ts', line: 1 }],
            }
          : fixtures.QA_PASS;
      return fixtures.fakeAgent({ review })(options);
    },
  });
  h.setCommands({ test: coding.LOGIN_TESTS_PASS });
  assert.equal((await coding.applyFirstRound(h)).ok, true);
  const task = await coding.settleLoop(h.call, 'auth-email-login', (view) => view.status !== 'in_progress' && view.status !== 'in_review');
  assert.equal(reviews, 2);
  assert.equal(task.codingRun?.status, 'submitted');
  assert.equal(task.codingRun?.attempt, 2);
  assert.equal(task.codingRun?.trigger, 'qa_rejected');
  assert.match(h.prompts[1], /QA rejected[\s\S]*\[major\] src\/auth\/application\/login-user\.ts:1 没有处理空密码/);
  const events = await h.activity.recent({ days: 1, limit: 100 });
  assert.equal(events.filter((event) => event.kind === 'package_transition' && event.transition === 'coding_submitted').length, 2);
});

// The whole path a Coding Agent package takes: one reviewed round, passing
// checks, QA, acceptance and a local commit of the scope files only.
test('end to end: coding round → checks → QA → done → commit', async () => {
  const h = await coding.loopHarness({ agent: async (options) => fixtures.fakeAgent({ review: fixtures.QA_PASS })(options) });
  h.setCommands({ test: coding.LOGIN_TESTS_PASS });
  assert.equal((await coding.applyFirstRound(h)).ok, true);
  const finished = await coding.settleLoop(h.call, 'auth-email-login', (view) => view.status === 'done' || view.status === 'accepting');
  // Evidence that needs a human look stops at acceptance; the developer accepts.
  assert.equal(finished.status, 'accepting', JSON.stringify(finished.review));
  assert.equal((await h.call(CHANNELS.packagesTransition, 'auth-email-login', 'accepted')).ok, true);
  assert.equal(finished.codingRun?.status, 'submitted');
  assert.equal(finished.codingRun?.attempt, 1);
  const preview = (await h.call(CHANNELS.commitPreview, 'auth-email-login')).data;
  assert.deepEqual(preview.files, [h.file]);
  const commit = await h.call(CHANNELS.commitCreate, 'auth-email-login', preview.message, preview.files);
  assert.equal(commit.ok, true, JSON.stringify(commit.error));
  const { stdout } = await fixtures.run('git', ['show', '--name-only', '--format=', 'HEAD'], { cwd: h.root });
  assert.deepEqual(stdout.trim().split('\n'), [h.file]);
  assert.equal((await fixtures.run('git', ['status', '--porcelain', '--', h.file], { cwd: h.root })).stdout, '');
});

test('coding timeout: the round uses the configured limit and keeps the partial patch for review', async () => {
  const h = await coding.loopHarness({ timesOut: (round) => round === 1, agent: async (options) => fixtures.fakeAgent({ review: fixtures.QA_PASS })(options) });
  h.setCommands({ test: coding.LOGIN_TESTS_PASS });
  assert.equal((await h.call(CHANNELS.preferencesSet, fixtures.validPrefs({ coding: { timeoutMinutes: 60 } }))).ok, true);
  assert.equal((await h.call(CHANNELS.codingStatus)).data.config.timeoutMinutes, 60);
  await h.call(CHANNELS.codingStart, 'auth-email-login', { instruction: '实现登录' });
  const task = await fixtures.settleCoding(h.call, 'auth-email-login');
  assert.deepEqual(h.timeouts, [60 * 60 * 1000]);
  assert.equal(task.codingRun?.status, 'ready');
  assert.equal(task.codingRun?.halt, 'timed_out');
  assert.equal(task.codingRun?.error?.code, 'coding_timeout');
  assert.deepEqual(
    task.codingRun?.files.map((file) => file.path),
    [h.file],
  );
  // The developer can still apply what was written.
  assert.equal(
    (
      await h.call(CHANNELS.codingApply, 'auth-email-login', {
        digest: await coding.reviewedDigest(h.call, 'auth-email-login'),
        allowHighRisk: false,
        files: [h.file],
      })
    ).ok,
    true,
  );
  // Let the checks and review that applying starts finish inside this test.
  await coding.settleLoop(h.call, 'auth-email-login', (view) => view.status === 'accepting');
});

test('coding:active lists the packages with a round or its checks in flight', async () => {
  const release = Promise.withResolvers<void>();
  const h = await coding.loopHarness({ hold: release.promise });
  assert.deepEqual((await h.call(CHANNELS.codingActive)).data, []);
  await h.call(CHANNELS.codingStart, 'auth-email-login', { instruction: '实现登录' });
  assert.deepEqual((await h.call(CHANNELS.codingActive)).data, [{ packageId: 'auth-email-login', title: SAMPLE_TASKS[0].title }]);
  release.resolve();
  await fixtures.settleCoding(h.call, 'auth-email-login');
  // The round leaves the list once its run has fully settled.
  await h.idle();
  assert.deepEqual((await h.call(CHANNELS.codingActive)).data, []);
});

test('coding timeout: an automatic round that times out is never applied by itself', async () => {
  const h = await coding.loopHarness({ timesOut: (round) => round === 2 });
  h.setCommands({ test: coding.LOGIN_TESTS_FAIL });
  assert.equal((await coding.applyFirstRound(h)).ok, true);
  const task = await coding.settleLoop(h.call, 'auth-email-login', (view) => view.codingRun?.halt === 'timed_out');
  assert.equal(task.codingRun?.status, 'ready');
  assert.equal(task.codingRun?.attempt, 2);
  assert.equal(h.prompts.length, 2);
  // Round 1's patch is still what the working tree holds.
  assert.equal(await fs.readFile(path.join(h.root, h.file), 'utf8'), 'export const round = 1;\n');
});

test('coding loop: an automatic round that touches a high-risk file stops for the developer', async () => {
  const h = await coding.loopHarness({ highRisk: true });
  h.setCommands({ test: coding.LOGIN_TESTS_FAIL });
  assert.equal((await coding.applyFirstRound(h, true)).ok, true);
  const task = await coding.settleLoop(h.call, 'auth-email-login', (view) => view.codingRun?.halt === 'high_risk');
  assert.equal(task.codingRun?.status, 'ready');
  assert.equal(task.codingRun?.attempt, 2);
  assert.equal(h.prompts.length, 2);
});

test('data:reset-progress cancels a running coding round instead of waiting for it', async () => {
  // A round that only ends when it is cancelled, like a 30-minute CLI run.
  const h = await coding.loopHarness({ hold: new Promise(() => {}) });
  await h.call(CHANNELS.codingStart, 'auth-email-login', { instruction: '实现登录' });
  assert.deepEqual((await h.call(CHANNELS.codingActive)).data.length, 1);
  const reset = await h.call(CHANNELS.dataResetProgress);
  assert.equal(reset.ok, true);
  assert.equal((await h.call(CHANNELS.tasksGet, 'auth-email-login')).data.status, 'pending');
});

test('activity: an applied coding round is recorded as finished once', async () => {
  const h = await coding.loopHarness({ agent: async (options) => fixtures.fakeAgent({ review: fixtures.QA_PASS })(options) });
  h.setCommands({ test: coding.LOGIN_TESTS_PASS });
  assert.equal((await coding.applyFirstRound(h)).ok, true);
  await coding.settleLoop(h.call, 'auth-email-login', (view) => view.status === 'accepting');
  const events = await h.activity.recent({ days: 1, limit: 100 });
  assert.equal(events.filter((event) => event.kind === 'coding_run' && event.status === 'finished').length, 1);
});

test('costs: a coding round that fails after spending tokens still records them', async () => {
  const failure = new CodingExecError('exited', 'coding_exit_failed');
  failure.usage = { inputTokens: 500, outputTokens: 20, cachedInputTokens: null, reasoningTokens: null, costUsd: 0.42 };
  const h = await coding.loopHarness({ failWith: failure });
  await h.call(CHANNELS.codingStart, 'auth-email-login', { instruction: '实现登录' });
  const task = await fixtures.settleCoding(h.call, 'auth-email-login');
  assert.equal(task.codingRun?.status, 'failed');
  assert.equal(task.codingRun?.usage.costUsd, 0.42);
  await h.activity.flush();
  const costs = (await h.activity.window(1)).flatMap((record) => (record.kind === 'agent_cost' && record.agent === 'coding-agent' ? [record] : []));
  assert.equal(costs.length, 1);
  assert.equal(costs[0].call?.costUsd, 0.42);
});

test('coding isolation: sandbox mode runs under userData as the current user, and later reads follow the run', async () => {
  const seen: { prepare?: unknown; run?: unknown; probe?: unknown; read: unknown[]; clean: unknown[] } = { read: [], clean: [] };
  const preview = fixtures.filePatch('tests/auth/login-user.test.ts', 'test("x", () => {});');
  const h = await fixtures.harness({
    seedState: {
      'auth-edge-tests': { status: 'in_progress', baseline: 'HEAD', claimedAt: new Date().toISOString(), completedSteps: [], deviations: [], review: null },
    },
    coding: {
      codingProbe: async (options) => {
        seen.probe = options?.sandbox;
        return fixtures.codingRuntime({ boundary: 'sandbox' });
      },
      codingPrepare: async (_root, _baseline, options) => {
        seen.prepare = options;
        return { runName: options!.runName!, directory: options!.runName! };
      },
      codingRun: async (options) => {
        seen.run = options.sandbox;
        return {
          output: 'done',
          usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: null, reasoningTokens: null, costUsd: null },
          events: [],
          sessionId: null,
        };
      },
      codingReadPatch: async (_runName, _scope, options) => {
        seen.read.push(options?.sandbox);
        return preview;
      },
      codingApplyPatch: async () => ({ written: [], markers: [], kept: [] }),
      codingClean: async (_runName, options) => void seen.clean.push(options?.sandbox),
      codingSnapshot: async (_root, baseline) => baseline,
    },
  });
  const saved = await h.call(CHANNELS.preferencesSet, fixtures.validPrefs({ coding: { isolation: 'sandbox', extraRead: ['/srv/shared'], extraWrite: [] } }));
  assert.equal(saved.ok, true, JSON.stringify(saved));
  await h.call(CHANNELS.codingStatus);
  assert.deepEqual((seen.probe as { extraRead: string[] }).extraRead, ['/srv/shared']);

  await h.call(CHANNELS.codingStart, 'auth-edge-tests', { instruction: '实现边界测试' });
  const ready = await fixtures.settleCoding(h.call, 'auth-edge-tests');
  const run = ready.codingRun!;
  assert.equal(path.dirname(run.runName), path.join(h.configDir, 'coding-runs'));
  assert.equal(run.user, os.userInfo().username);
  const prepared = seen.prepare as { sandbox?: { runRoot: string }; cli?: string };
  assert.equal(prepared.sandbox?.runRoot, path.join(h.configDir, 'coding-runs'));
  assert.equal(prepared.cli, run.cli);
  assert.ok(seen.run, 'the CLI ran with the sandbox');

  // A run keeps the mode it started in, even after the setting changes.
  await h.call(CHANNELS.preferencesSet, fixtures.validPrefs());
  await h.call(CHANNELS.codingPatch, 'auth-edge-tests');
  assert.ok(seen.read.at(-1), 'the patch is still read inside the sandbox');
  await h.call(CHANNELS.codingCancel, 'auth-edge-tests');
  assert.ok(seen.clean.at(-1), 'the run is cleaned as a sandbox run');
});
