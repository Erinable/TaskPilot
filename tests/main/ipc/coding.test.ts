// IPC channels of the coding domain (src/main/ipc/coding.ts).
import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

import type { CodingDeps } from '../../../src/main/coding_runtime.ts';
import type { TaskView } from '../../../src/shared/ipc/packages.ts';
import type { CodingPatchPreview, CodingRuntimeStatus } from '../../../src/shared/coding_types.ts';
import { applyPatch, parsePatchPreview } from '../../../src/main/coding_workspace.ts';
import { previewMerge } from '../../../src/main/patch_merge.ts';
import { CodingExecError } from '../../../src/main/coding_exec.ts';
import { CHANNELS } from '../../../src/shared/ipc_channels.ts';
import { SAMPLE_TASKS } from '../fixtures/sample_tasks.ts';
import * as fixtures from './harness.ts';

// Runs real git and npm processes per test; slow machines and CI need the room.
vi.setConfig({ testTimeout: 20_000 });

// The same patch with real blob ids, as the isolated run's `git diff` writes
// it, so a three-way merge can find the base.
const realPatch = async (root: string, file: string, line: string): Promise<CodingPatchPreview> => {
  const blobOf = async (text: string) => (await execFileAsyncWithInput('git', ['-C', root, 'hash-object', '-w', '--stdin'], text)).trim();
  const before = await blobOf('export {};\n');
  const after = await blobOf(`${line}\n`);
  return parsePatchPreview(
    `diff --git a/${file} b/${file}\nindex ${before}..${after} 100644\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-export {};\n+${line}\n`,
    SAMPLE_TASKS[0].fileScope,
  );
};
const execFileAsyncWithInput = (command: string, args: string[], input: string) =>
  new Promise<string>((resolve, reject) => {
    const child = execFile(command, args, (error, stdout) => (error ? reject(error) : resolve(stdout)));
    child.stdin?.end(input);
  });
// Polls until the automatic loop reaches `done`.
const settleLoop = async (call: fixtures.TestCall, id: string, done: (task: TaskView) => boolean): Promise<TaskView> => {
  let last = 'no response';
  const deadline = Date.now() + fixtures.SETTLE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const response = await call(CHANNELS.codingGet, id);
    if (response.ok) {
      const task = response.data as TaskView;
      last = JSON.stringify({ status: task.status, run: task.codingRun });
      if (done(task)) return task;
    } else last = JSON.stringify(response.error);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`coding loop never settled: ${last}`);
};

test('coding IPC registers all seven channels and preserves terminal events', async () => {
  const preview = fixtures.filePatch('tests/auth/login-user.test.ts', 'test("x", () => {});');
  let probeCalls = 0;
  let prepareCalls = 0;
  let runCalls = 0;
  const events = [{ sequence: 0, at: new Date().toISOString(), type: 'text' as const, text: 'done' }];
  const prepare: CodingDeps['prepare'] = async (_root, _baseline, options) => {
    prepareCalls += 1;
    assert.equal(options?.runName?.startsWith('/Users/taskpilot-coder/TaskPilotRuns/'), true);
    assert.ok(options?.signal);
    return { runName: options!.runName!, directory: options!.runName! };
  };
  const runCoding: CodingDeps['run'] = async (options) => {
    runCalls += 1;
    assert.ok(options.signal);
    options.onEvent?.(events[0]);
    return {
      output: 'done',
      usage: { inputTokens: 1, outputTokens: 2, cachedInputTokens: null, reasoningTokens: null, costUsd: null },
      events,
      sessionId: null,
    };
  };
  const h = await fixtures.harness({
    seedState: {
      'auth-edge-tests': { status: 'in_progress', baseline: 'HEAD', claimedAt: new Date().toISOString(), completedSteps: [], deviations: [], review: null },
    },
    coding: {
      codingProbe: async () => {
        probeCalls += 1;
        return fixtures.codingRuntime();
      },
      codingPrepare: prepare,
      codingRun: runCoding,
      codingReadPatch: async () => preview,
      codingApplyPatch: async () => ({ written: ['tests/auth/login-user.test.ts'], markers: [], kept: [] }),
      codingClean: async () => {},
      codingSnapshot: async (_root, baseline) => baseline,
    },
  });
  const status = await h.call(CHANNELS.codingStatus);
  assert.equal(status.ok, true);
  // Development shows the repository copy of the setup script.
  assert.equal((status.data as CodingRuntimeStatus).setupScript, 'scripts/setup-coding-agent-user.sh');
  const started = await h.call(CHANNELS.codingStart, 'auth-edge-tests', { instruction: '实现边界测试' });
  assert.equal(started.ok, true);
  assert.equal((await h.call(CHANNELS.codingGet, 'auth-edge-tests')).ok, true);
  const ready = await fixtures.settleCoding(h.call, 'auth-edge-tests');
  assert.equal(ready.codingRun?.status, 'ready');
  const fresh = await h.call(CHANNELS.codingGet, 'auth-edge-tests');
  assert.equal(fresh.ok, true);
  if (!fresh.ok) throw new Error(fresh.error.message);
  assert.equal((fresh.data as TaskView).codingRun?.status, 'ready', JSON.stringify(fresh.data));
  const page = await h.call(CHANNELS.codingEvents, 'auth-edge-tests', -1);
  assert.equal(page.ok, true);
  if (!page.ok) throw new Error(page.error.message);
  const eventPage = page.data as { events: { text: string }[] };
  assert.equal(eventPage.events[0]?.text, 'done');
  const patchResponse = await h.call(CHANNELS.codingPatch, 'auth-edge-tests');
  assert.equal(patchResponse.ok, true, JSON.stringify(patchResponse));
  // What the panel confirms: the patch and how it merges with the working tree.
  const reviewed = patchResponse.data as CodingPatchPreview;
  assert.deepEqual(reviewed.merge, [{ path: 'tests/auth/login-user.test.ts', state: 'clean', markers: false }]);
  // The bare patch digest is not enough any more.
  assert.equal(
    (await h.call(CHANNELS.codingApply, 'auth-edge-tests', { digest: preview.digest, allowHighRisk: true, files: ['tests/auth/login-user.test.ts'] })).error
      .code,
    'coding_digest_mismatch',
  );
  const missingFiles = await h.call(CHANNELS.codingApply, 'auth-edge-tests', { digest: reviewed.mergeDigest, allowHighRisk: true });
  assert.equal(missingFiles.ok, false);
  const applied = await h.call(CHANNELS.codingApply, 'auth-edge-tests', {
    digest: reviewed.mergeDigest,
    allowHighRisk: true,
    files: ['tests/auth/login-user.test.ts'],
  });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  // No submit checks are configured, so the patch goes straight to QA.
  const submitted = await settleLoop(h.call, 'auth-edge-tests', (task) => task.status !== 'in_progress');
  assert.equal(submitted.codingRun?.status, 'submitted');
  assert.equal((await h.call(CHANNELS.codingCancel, 'auth-edge-tests')).data, false);
  assert.equal(probeCalls, 1);
  assert.equal(prepareCalls, 1);
  assert.equal(runCalls, 1);
  await h.shutdown();
});

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
const loopHarness = async ({
  agent = null,
  highRisk = false,
  timesOut = null,
  hold = null,
  failWith = null,
}: {
  agent?: fixtures.FakeAgent | null;
  highRisk?: boolean;
  // The CLI run waits on this before it returns.
  hold?: Promise<void> | null;
  // Every CLI run throws this.
  failWith?: Error | null;
  // Rounds (1-based) whose CLI run times out after writing its patch.
  timesOut?: ((round: number) => boolean) | null;
} = {}) => {
  const prompts: string[] = [];
  const timeouts: number[] = [];
  const reads: Parameters<NonNullable<CodingDeps['readPatch']>>[2][] = [];
  const file = highRisk ? 'tests/auth/login-user.test.ts' : 'src/auth/application/login-user.ts';
  const preview = () => fixtures.filePatch(file, `export const round = ${prompts.length};`, SAMPLE_TASKS[0].fileScope);
  let root = '';
  const h = await fixtures.harness({
    agent,
    coding: {
      codingProbe: async () => fixtures.codingRuntime(),
      codingPrepare: async (_root, _baseline, options) => ({ runName: options!.runName!, directory: options!.runName! }),
      codingRun: async (options) => {
        prompts.push(options.prompt);
        timeouts.push(options.timeoutMs!);
        // Like the real runner, a cancel ends the wait, even one that came first.
        if (hold) {
          const cancelled = () => Object.assign(new Error('Coding run was cancelled'), { code: 'coding_aborted' });
          if (options.signal?.aborted) throw cancelled();
          await Promise.race([hold, new Promise((_resolve, reject) => options.signal?.addEventListener('abort', () => reject(cancelled()), { once: true }))]);
        }
        if (failWith) throw failWith;
        if (timesOut?.(prompts.length)) throw Object.assign(new Error('Coding run timed out'), { code: 'coding_timeout' });
        return {
          output: '',
          usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: null, reasoningTokens: null, costUsd: 0.1 },
          events: [],
          sessionId: null,
        };
      },
      codingReadPatch: async (_runName, _scope, options) => {
        reads.push(options);
        return preview();
      },
      codingApplyPatch: async (_root, patch) => {
        await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
        await fs.writeFile(
          path.join(root, file),
          `${patch
            .split('\n')
            .find((line) => line.startsWith('+export'))!
            .slice(1)}\n`,
        );
        return { written: [file], markers: [], kept: [] };
      },
      codingClean: async () => {},
      codingSnapshot: async (_root, baseline) => baseline,
    },
  });
  root = h.root;
  const head = (await fixtures.run('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
  await h.store.transition('auth-email-login', 'claim', 'human', { baseline: head });
  return { ...h, prompts, timeouts, reads, preview, file };
};
test('coding: a practised package keeps Coding Agent out', async () => {
  const h = await loopHarness();
  await h.store.transition('auth-email-login', 'release', 'human');
  const head = (await fixtures.run('git', ['rev-parse', 'HEAD'], { cwd: h.root })).stdout.trim();
  await h.store.transition('auth-email-login', 'claim', 'human', { baseline: head, mode: 'practice' });
  const refused = await h.call(CHANNELS.codingStart, 'auth-email-login', { instruction: '实现登录' });
  assert.equal(refused.error.code, 'practice_mode');
  assert.equal(h.prompts.length, 0);
});

test("coding: a Rust repository's patch is read with the Rust preset's protected files", async () => {
  const h = await loopHarness();
  await fs.writeFile(path.join(h.root, 'Cargo.toml'), '[package]\nname = "demo"\n');
  await fixtures.run('git', ['add', 'Cargo.toml'], { cwd: h.root });
  await fixtures.run('git', ['-c', 'user.email=e@x', '-c', 'user.name=t', 'commit', '-qm', 'cargo'], { cwd: h.root });
  await h.call(CHANNELS.codingStart, 'auth-email-login', { instruction: '实现登录' });
  await fixtures.settleCoding(h.call, 'auth-email-login');
  const rules = h.reads[0]?.rules;
  assert.ok(rules);
  assert.equal(parsePatchPreview(fixtures.filePatch('Cargo.lock', 'x').patch, undefined, rules).files[0]?.highRisk, true);
  assert.equal(parsePatchPreview(fixtures.filePatch('pyproject.toml', 'x').patch, undefined, rules).files[0]?.highRisk, false);
});

test('coding: the prompt lists steps and the exact names of linked tests', async () => {
  const h = await loopHarness();
  await h.call(CHANNELS.codingStart, 'auth-email-login', { instruction: '实现登录' });
  await fixtures.settleCoding(h.call, 'auth-email-login');
  assert.match(h.prompts[0], /Steps:\n1\. /);
  assert.match(h.prompts[0], /- 成功返回 token，不暴露用户是否存在 \(proved by a test named exactly "login succeeds with valid credentials"\)/);
});

test('coding: a planned package hands Coding Agent the Architect summary', async () => {
  const h = await loopHarness({ agent: fixtures.fakeAgent() });
  const created = await h.call(CHANNELS.requirementsCreate, { text: '用户可以用邮箱登录' });
  await fixtures.settle(h.call, created.data.id);
  await h.call(CHANNELS.requirementsPlan, created.data.id, ['5 次']);
  await fixtures.settle(h.call, created.data.id);
  await h.call(CHANNELS.requirementsPublish, created.data.id);
  const id = `${created.data.id}-wp1`;
  await h.call(CHANNELS.transition, id, 'claim', { mode: 'ai' });
  await h.call(CHANNELS.codingStart, id, { instruction: '实现登录' });
  await fixtures.settleCoding(h.call, id);
  assert.match(h.prompts[0], /<interface_summary author="Architect">\nsrc\/auth\/application\/login-user\.ts: 登录用例占位/);
});

const applyFirstRound = async (h: Awaited<ReturnType<typeof loopHarness>>, allowHighRisk = false) => {
  await h.call(CHANNELS.codingStart, 'auth-email-login', { instruction: '实现登录' });
  const ready = await fixtures.settleCoding(h.call, 'auth-email-login');
  assert.equal(ready.codingRun?.status, 'ready');
  return h.call(CHANNELS.codingApply, 'auth-email-login', { digest: await reviewedDigest(h.call, 'auth-email-login'), allowHighRisk, files: [h.file] });
};
// The digest the panel confirms, from coding:patch.
const reviewedDigest = async (call: fixtures.TestCall, id: string) => {
  const response = await call(CHANNELS.codingPatch, id);
  if (!response.ok) throw new Error(response.error.message);
  return (response.data as CodingPatchPreview).mergeDigest;
};
const LOGIN_TESTS_FAIL = { command: process.execPath, args: ['-e', "console.log('not ok 1 - login succeeds with valid credentials'); process.exit(1)"] };
const LOGIN_TESTS_PASS = {
  command: process.execPath,
  args: ['-e', "console.log('ok 1 - login succeeds with valid credentials\\nok 2 - login failures are indistinguishable')"],
};

test('coding loop: failing checks go back to the agent until three automatic rounds are used', async () => {
  const h = await loopHarness();
  h.setCommands({ test: LOGIN_TESTS_FAIL });
  assert.equal((await applyFirstRound(h)).ok, true);
  const task = await settleLoop(h.call, 'auth-email-login', (view) => view.codingRun?.halt === 'attempts_exhausted');
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
  const h = await loopHarness({
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
  h.setCommands({ test: LOGIN_TESTS_PASS });
  assert.equal((await applyFirstRound(h)).ok, true);
  const task = await settleLoop(h.call, 'auth-email-login', (view) => view.status !== 'in_progress' && view.status !== 'in_review');
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
  const h = await loopHarness({ agent: async (options) => fixtures.fakeAgent({ review: fixtures.QA_PASS })(options) });
  h.setCommands({ test: LOGIN_TESTS_PASS });
  assert.equal((await applyFirstRound(h)).ok, true);
  const finished = await settleLoop(h.call, 'auth-email-login', (view) => view.status === 'done' || view.status === 'accepting');
  // Evidence that needs a human look stops at acceptance; the developer accepts.
  assert.equal(finished.status, 'accepting', JSON.stringify(finished.review));
  assert.equal((await h.call(CHANNELS.transition, 'auth-email-login', 'accepted')).ok, true);
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

test('coding conflict: an edit to the same line is listed, and applying needs a choice', async () => {
  let root = '';
  const h = await fixtures.harness({
    agent: async (options) => fixtures.fakeAgent({ review: fixtures.QA_PASS })(options),
    coding: {
      codingProbe: async () => fixtures.codingRuntime(),
      codingPrepare: async (_root, _baseline, options) => ({ runName: options!.runName!, directory: options!.runName! }),
      codingRun: async () => ({
        output: '',
        usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: null, reasoningTokens: null, costUsd: 0.1 },
        events: [],
        sessionId: null,
      }),
      codingReadPatch: async () => realPatch(root, 'src/auth/application/login-user.ts', 'export const login = "agent";'),
      codingClean: async () => {},
      // The round starts from what is committed.
      codingSnapshot: async (_root, baseline) => baseline,
      codingPreviewMerge: previewMerge,
      codingApplyPatch: applyPatch,
    },
  });
  root = h.root;
  const head = (await fixtures.run('git', ['rev-parse', 'HEAD'], { cwd: h.root })).stdout.trim();
  await h.store.transition('auth-email-login', 'claim', 'human', { baseline: head });
  h.setCommands({ test: LOGIN_TESTS_PASS });
  await h.call(CHANNELS.codingStart, 'auth-email-login', { instruction: '实现登录' });
  await fixtures.settleCoding(h.call, 'auth-email-login');
  // Meanwhile the developer changed the same line.
  const file = path.join(h.root, 'src/auth/application/login-user.ts');
  await fs.writeFile(file, 'export const login = "mine";\n');
  const preview = (await h.call(CHANNELS.codingPatch, 'auth-email-login')).data as CodingPatchPreview;
  assert.deepEqual(preview.merge, [{ path: 'src/auth/application/login-user.ts', state: 'conflict', markers: true }]);
  const input = { digest: preview.mergeDigest, allowHighRisk: false, files: ['src/auth/application/login-user.ts'] };
  assert.equal((await h.call(CHANNELS.codingApply, 'auth-email-login', input)).error.code, 'merge_unresolved');
  assert.equal(
    (await h.call(CHANNELS.codingApply, 'auth-email-login', { ...input, resolutions: { 'src/auth/application/login-user.ts': 'bogus' } })).error.code,
    'invalid_argument',
  );
  assert.equal(await fs.readFile(file, 'utf8'), 'export const login = "mine";\n');

  // Markers: written, and the checks wait until they are cleared.
  const applied = await h.call(CHANNELS.codingApply, 'auth-email-login', { ...input, resolutions: { 'src/auth/application/login-user.ts': 'markers' } });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.deepEqual(applied.data.markers, ['src/auth/application/login-user.ts']);
  assert.match(await fs.readFile(file, 'utf8'), /<<<<<<< 你的改动\nexport const login = "mine";\n=======\nexport const login = "agent";\n>>>>>>> Coding Agent/);
  const held = (await h.call(CHANNELS.codingGet, 'auth-email-login')).data as TaskView;
  assert.equal(held.codingRun?.status, 'applied');
  assert.equal(held.codingRun?.halt, 'markers');
  assert.equal((await h.call(CHANNELS.codingResume, 'auth-email-login')).error.code, 'merge_markers_left');

  // The developer resolves it; the flow goes on to the checks and QA.
  await fs.writeFile(file, 'export const login = "both";\n');
  assert.equal((await h.call(CHANNELS.codingResume, 'auth-email-login')).ok, true);
  const done = await settleLoop(h.call, 'auth-email-login', (view) => view.status === 'accepting');
  assert.equal(done.codingRun?.status, 'submitted');
});

test('coding conflict: the digest goes stale when a patched file changes after preview', async () => {
  let root = '';
  const h = await fixtures.harness({
    coding: {
      codingProbe: async () => fixtures.codingRuntime(),
      codingPrepare: async (_root, _baseline, options) => ({ runName: options!.runName!, directory: options!.runName! }),
      codingRun: async () => ({
        output: '',
        usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: null, reasoningTokens: null, costUsd: null },
        events: [],
        sessionId: null,
      }),
      codingReadPatch: async () => realPatch(root, 'src/auth/application/login-user.ts', 'export const login = "agent";'),
      codingClean: async () => {},
      codingSnapshot: async (_root, baseline) => baseline,
      codingPreviewMerge: previewMerge,
      codingApplyPatch: applyPatch,
    },
  });
  root = h.root;
  const head = (await fixtures.run('git', ['rev-parse', 'HEAD'], { cwd: h.root })).stdout.trim();
  await h.store.transition('auth-email-login', 'claim', 'human', { baseline: head });
  await h.call(CHANNELS.codingStart, 'auth-email-login', { instruction: '实现登录' });
  await fixtures.settleCoding(h.call, 'auth-email-login');
  const preview = (await h.call(CHANNELS.codingPatch, 'auth-email-login')).data as CodingPatchPreview;
  assert.equal(preview.merge?.[0].state, 'clean');
  // An edit after the developer looked: applying must not go ahead on stale information.
  await fs.writeFile(path.join(h.root, 'src/auth/application/login-user.ts'), 'export const login = "mine";\n');
  const response = await h.call(CHANNELS.codingApply, 'auth-email-login', {
    digest: preview.mergeDigest,
    allowHighRisk: false,
    files: ['src/auth/application/login-user.ts'],
  });
  assert.equal(response.error.code, 'coding_digest_mismatch');
  assert.equal(await fs.readFile(path.join(h.root, 'src/auth/application/login-user.ts'), 'utf8'), 'export const login = "mine";\n');
});

test('coding conflict: an automatic round that conflicts stops for the developer instead of overwriting', async () => {
  let round = 0;
  let root = '';
  const h = await fixtures.harness({
    coding: {
      codingProbe: async () => fixtures.codingRuntime(),
      codingPrepare: async (_root, _baseline, options) => ({ runName: options!.runName!, directory: options!.runName! }),
      codingRun: async () => {
        round += 1;
        return {
          output: '',
          usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: null, reasoningTokens: null, costUsd: null },
          events: [],
          sessionId: null,
        };
      },
      // Round 1 changes the line; round 2 changes it again, from the same start.
      codingReadPatch: async () => realPatch(root, 'src/auth/application/login-user.ts', `export const round = ${round};`),
      codingClean: async () => {},
      codingSnapshot: async (_root, baseline) => baseline,
      codingPreviewMerge: previewMerge,
      codingApplyPatch: applyPatch,
    },
  });
  root = h.root;
  const head = (await fixtures.run('git', ['rev-parse', 'HEAD'], { cwd: h.root })).stdout.trim();
  await h.store.transition('auth-email-login', 'claim', 'human', { baseline: head });
  h.setCommands({ test: LOGIN_TESTS_FAIL });
  await h.call(CHANNELS.codingStart, 'auth-email-login', { instruction: '实现登录' });
  await fixtures.settleCoding(h.call, 'auth-email-login');
  const preview = (await h.call(CHANNELS.codingPatch, 'auth-email-login')).data as CodingPatchPreview;
  assert.equal(
    (
      await h.call(CHANNELS.codingApply, 'auth-email-login', {
        digest: preview.mergeDigest,
        allowHighRisk: false,
        files: ['src/auth/application/login-user.ts'],
      })
    ).ok,
    true,
  );
  // Checks fail, so round 2 starts. Round 2's patch is against the original
  // line, which round 1 already changed in the working tree: a conflict.
  const stopped = await settleLoop(h.call, 'auth-email-login', (view) => view.codingRun?.halt === 'conflict');
  assert.equal(stopped.codingRun?.status, 'ready');
  assert.equal(stopped.codingRun?.attempt, 2);
  // Round 1's change is untouched.
  assert.equal(await fs.readFile(path.join(h.root, 'src/auth/application/login-user.ts'), 'utf8'), 'export const round = 1;\n');
});

test('coding timeout: the round uses the configured limit and keeps the partial patch for review', async () => {
  const h = await loopHarness({ timesOut: (round) => round === 1, agent: async (options) => fixtures.fakeAgent({ review: fixtures.QA_PASS })(options) });
  h.setCommands({ test: LOGIN_TESTS_PASS });
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
        digest: await reviewedDigest(h.call, 'auth-email-login'),
        allowHighRisk: false,
        files: [h.file],
      })
    ).ok,
    true,
  );
  // Let the checks and review that applying starts finish inside this test.
  await settleLoop(h.call, 'auth-email-login', (view) => view.status === 'accepting');
});

test('coding:active lists the packages with a round or its checks in flight', async () => {
  const release = Promise.withResolvers<void>();
  const h = await loopHarness({ hold: release.promise });
  assert.deepEqual((await h.call(CHANNELS.codingActive)).data, []);
  await h.call(CHANNELS.codingStart, 'auth-email-login', { instruction: '实现登录' });
  assert.deepEqual((await h.call(CHANNELS.codingActive)).data, [{ packageId: 'auth-email-login', title: SAMPLE_TASKS[0].title }]);
  release.resolve();
  await fixtures.settleCoding(h.call, 'auth-email-login');
  // The round leaves the list once its run has fully settled.
  let active = (await h.call(CHANNELS.codingActive)).data;
  for (let index = 0; index < 100 && active.length; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    active = (await h.call(CHANNELS.codingActive)).data;
  }
  assert.deepEqual(active, []);
});

test('coding timeout: an automatic round that times out is never applied by itself', async () => {
  const h = await loopHarness({ timesOut: (round) => round === 2 });
  h.setCommands({ test: LOGIN_TESTS_FAIL });
  assert.equal((await applyFirstRound(h)).ok, true);
  const task = await settleLoop(h.call, 'auth-email-login', (view) => view.codingRun?.halt === 'timed_out');
  assert.equal(task.codingRun?.status, 'ready');
  assert.equal(task.codingRun?.attempt, 2);
  assert.equal(h.prompts.length, 2);
  // Round 1's patch is still what the working tree holds.
  assert.equal(await fs.readFile(path.join(h.root, h.file), 'utf8'), 'export const round = 1;\n');
});

test('coding loop: an automatic round that touches a high-risk file stops for the developer', async () => {
  const h = await loopHarness({ highRisk: true });
  h.setCommands({ test: LOGIN_TESTS_FAIL });
  assert.equal((await applyFirstRound(h, true)).ok, true);
  const task = await settleLoop(h.call, 'auth-email-login', (view) => view.codingRun?.halt === 'high_risk');
  assert.equal(task.codingRun?.status, 'ready');
  assert.equal(task.codingRun?.attempt, 2);
  assert.equal(h.prompts.length, 2);
});

test('data:reset-progress cancels a running coding round instead of waiting for it', async () => {
  // A round that only ends when it is cancelled, like a 30-minute CLI run.
  const h = await loopHarness({ hold: new Promise(() => {}) });
  await h.call(CHANNELS.codingStart, 'auth-email-login', { instruction: '实现登录' });
  assert.deepEqual((await h.call(CHANNELS.codingActive)).data.length, 1);
  const reset = await Promise.race([h.call(CHANNELS.dataResetProgress), new Promise((resolve) => setTimeout(() => resolve('hung'), 3000))]);
  assert.notEqual(reset, 'hung', 'reset waited for the coding round');
  assert.equal((await h.call(CHANNELS.getTask, 'auth-email-login')).data.status, 'pending');
});

test('activity: an applied coding round is recorded as finished once', async () => {
  const h = await loopHarness({ agent: async (options) => fixtures.fakeAgent({ review: fixtures.QA_PASS })(options) });
  h.setCommands({ test: LOGIN_TESTS_PASS });
  assert.equal((await applyFirstRound(h)).ok, true);
  await settleLoop(h.call, 'auth-email-login', (view) => view.status === 'accepting');
  const events = await h.activity.recent({ days: 1, limit: 100 });
  assert.equal(events.filter((event) => event.kind === 'coding_run' && event.status === 'finished').length, 1);
});

test('costs: a coding round that fails after spending tokens still records them', async () => {
  const failure = new CodingExecError('exited', 'coding_exit_failed');
  failure.usage = { inputTokens: 500, outputTokens: 20, cachedInputTokens: null, reasoningTokens: null, costUsd: 0.42 };
  const h = await loopHarness({ failWith: failure });
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
