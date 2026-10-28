// Shared practice fixtures for the IPC lifecycle tests.
import fs from 'node:fs/promises';
import path from 'node:path';

import type { TaskView } from '../../../src/shared/ipc/packages.ts';
import { parsePatchPreview } from '../../../src/main/coding/coding_workspace.ts';
import { CHANNELS } from '../../../src/shared/ipc_channels.ts';
import * as fixtures from './harness.ts';

export const REFERENCE_PATCH = fixtures.filePatch('tests/auth/login-user.test.ts', 'test("reference", () => {});').patch;

// A practice harness whose reference run waits on `hold` when given.
export const practiceHarness = async ({
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

export const settleTask = async (call, id, done: (task: TaskView) => boolean) =>
  fixtures.until(async () => (await call(CHANNELS.tasksGet, id)).data as TaskView, done, 'practice task');

export const writeSubmission = async (root: string) => {
  await fs.mkdir(path.join(root, 'tests/auth'), { recursive: true });
  await fs.writeFile(path.join(root, 'tests/auth/login-user.test.ts'), 'test("case-insensitive", () => {});\n');
};

export const gradedWithReference = async (agent = fixtures.fakeAgent()) => {
  const h = await practiceHarness({ agent });
  await h.call(CHANNELS.packagesTransition, 'auth-edge-tests', 'claim', { mode: 'practice' });
  await settleTask(h.call, 'auth-edge-tests', (task) => task.referenceRun?.status === 'ready');
  await writeSubmission(h.root);
  await h.call(CHANNELS.packagesTransition, 'auth-edge-tests', 'submit_for_review');
  await settleTask(h.call, 'auth-edge-tests', (task) => task.grade?.status === 'done');
  return h;
};

export const settleExplanation = (h, status: string) => settleTask(h.call, 'auth-edge-tests', (task) => task.grade?.explanation?.status === status);
