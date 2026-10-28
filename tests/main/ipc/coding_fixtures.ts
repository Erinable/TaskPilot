// Shared coding-loop fixtures for the IPC lifecycle tests.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { CodingDeps } from '../../../src/main/coding/coding_runtime.ts';
import type { TaskView } from '../../../src/shared/ipc/packages.ts';
import type { CodingPatchPreview } from '../../../src/shared/coding_types.ts';
import { CHANNELS } from '../../../src/shared/ipc_channels.ts';
import { SAMPLE_TASKS } from '../fixtures/sample_tasks.ts';
import * as fixtures from './harness.ts';

export const settleLoop = async (call: fixtures.TestCall, id: string, done: (task: TaskView) => boolean): Promise<TaskView> => {
  const task = (await fixtures.settleReview(call, id)) as TaskView;
  assert.ok(done(task), `coding loop did not reach the expected final state: ${JSON.stringify(task)}`);
  return task;
};

export const loopHarness = async ({
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

export const applyFirstRound = async (h: Awaited<ReturnType<typeof loopHarness>>, allowHighRisk = false) => {
  await h.call(CHANNELS.codingStart, 'auth-email-login', { instruction: '实现登录' });
  const ready = await fixtures.settleCoding(h.call, 'auth-email-login');
  assert.equal(ready.codingRun?.status, 'ready');
  return h.call(CHANNELS.codingApply, 'auth-email-login', { digest: await reviewedDigest(h.call, 'auth-email-login'), allowHighRisk, files: [h.file] });
};
// The digest the panel confirms, from coding:patch.
export const reviewedDigest = async (call: fixtures.TestCall, id: string) => {
  const response = await call(CHANNELS.codingPatch, id);
  if (!response.ok) throw new Error(response.error.message);
  return (response.data as CodingPatchPreview).mergeDigest;
};
export const LOGIN_TESTS_FAIL = { command: process.execPath, args: ['-e', "console.log('not ok 1 - login succeeds with valid credentials'); process.exit(1)"] };
export const LOGIN_TESTS_PASS = {
  command: process.execPath,
  args: ['-e', "console.log('ok 1 - login succeeds with valid credentials\\nok 2 - login failures are indistinguishable')"],
};
