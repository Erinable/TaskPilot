// IPC channels of the coding domain (src/main/ipc/coding.ts).
import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';

import type { TaskView } from '../../../src/shared/ipc/packages.ts';
import type { CodingPatchPreview } from '../../../src/shared/coding_types.ts';
import { applyPatch, parsePatchPreview } from '../../../src/main/coding/coding_workspace.ts';
import { previewMerge } from '../../../src/main/coding/patch_merge.ts';
import { CHANNELS } from '../../../src/shared/ipc_channels.ts';
import { SAMPLE_TASKS } from '../fixtures/sample_tasks.ts';
import * as fixtures from './harness.ts';
import * as coding from './coding_fixtures.ts';

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
  h.setCommands({ test: coding.LOGIN_TESTS_PASS });
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
  const done = await coding.settleLoop(h.call, 'auth-email-login', (view) => view.status === 'accepting');
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
  h.setCommands({ test: coding.LOGIN_TESTS_FAIL });
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
  const stopped = await coding.settleLoop(h.call, 'auth-email-login', (view) => view.codingRun?.halt === 'conflict');
  assert.equal(stopped.codingRun?.status, 'ready');
  assert.equal(stopped.codingRun?.attempt, 2);
  // Round 1's change is untouched.
  assert.equal(await fs.readFile(path.join(h.root, 'src/auth/application/login-user.ts'), 'utf8'), 'export const round = 1;\n');
});
