/** @module-tag integration */
// A released claim must never retain a patch or continue its coding loop.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { applyPatch } from '../../../src/main/coding/coding_workspace.ts';
import { WorkPackageStore } from '../../../src/main/work_packages/work_package_store.ts';
import { CHANNELS } from '../../../src/shared/ipc_channels.ts';
import { until } from '../../fixtures/until.ts';
import * as fixtures from './harness.ts';
import * as coding from './coding_fixtures.ts';

const ID = 'auth-email-login';
const FILE = 'src/auth/application/login-user.ts';
const RESULT = {
  output: 'finished',
  usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: null, reasoningTokens: null, costUsd: 0.1 },
  events: [],
  sessionId: null,
};

// Real IPC registration and package store over a scratch git repository. Gates
// hold one async boundary at a time, including runtimes that ignore cancellation.
const releaseHarness = async (overrides: fixtures.CodingOverrides = {}) => {
  const cleaned: string[] = [];
  const h = await fixtures.harness({
    coding: {
      codingProbe: async () => fixtures.codingRuntime(),
      codingPrepare: async (_root, _baseline, options) => ({ runName: options!.runName!, directory: options!.runName! }),
      codingSnapshot: async (_root, baseline) => baseline,
      codingRun: async () => RESULT,
      codingReadPatch: async () => fixtures.filePatch(FILE, 'export const released = true;'),
      codingClean: async (runName) => void cleaned.push(runName),
      ...overrides,
    },
  });
  assert.equal((await h.call(CHANNELS.packagesTransition, ID, 'claim', { mode: 'ai' })).ok, true);
  await h.idle();
  return { ...h, cleaned };
};

const releaseAndClaim = async (h: Awaited<ReturnType<typeof fixtures.harness>>) => {
  assert.equal((await h.call(CHANNELS.packagesTransition, ID, 'release')).ok, true);
  assert.equal(h.store.get(ID).codingRun, null);
  assert.equal((await h.call(CHANNELS.packagesTransition, ID, 'claim', { mode: 'self' })).ok, true);
  assert.equal(h.store.get(ID).codingRun, null);
};

test('coding release: a reviewed ready patch cannot be read, applied or resumed after release or a new claim', async () => {
  const h = await coding.loopHarness();
  assert.equal((await h.call(CHANNELS.codingStart, ID, { instruction: 'first claim' })).ok, true);
  await h.idle();
  const digest = await coding.reviewedDigest(h.call, ID);
  const oldId = h.store.get(ID).codingRun!.id;
  const input = { digest, allowHighRisk: false, files: [h.file] };
  assert.equal((await h.call(CHANNELS.packagesTransition, ID, 'release')).ok, true);
  assert.equal(h.store.get(ID).status, 'pending');
  assert.equal(h.store.get(ID).codingRun, null);
  const reloaded = await new WorkPackageStore(h.repoDir).load(h.requirements.listTasks());
  assert.equal(reloaded.get(ID).codingRun, null);
  for (const channel of [CHANNELS.codingPatch, CHANNELS.codingApply, CHANNELS.codingResume]) {
    assert.equal((await h.call(channel, ID, input)).error.code, 'coding_not_running');
  }
  assert.equal(await fs.readFile(path.join(h.root, h.file), 'utf8'), 'export {};\n');
  assert.equal((await h.call(CHANNELS.packagesTransition, ID, 'claim', { mode: 'ai' })).ok, true);
  assert.equal((await h.call(CHANNELS.codingApply, ID, input)).error.code, 'coding_not_running');
  assert.equal((await h.call(CHANNELS.codingStart, ID, { instruction: 'new claim' })).ok, true);
  await h.idle();
  const fresh = h.store.get(ID).codingRun!;
  assert.notEqual(fresh.id, oldId);
  assert.equal(fresh.attempt, 1);
  assert.deepEqual(fresh.rounds, []);
  assert.equal(fresh.feedback, null);
  assert.equal((await h.call(CHANNELS.codingApply, ID, input)).error.code, 'coding_digest_mismatch');
  assert.equal(await fs.readFile(path.join(h.root, h.file), 'utf8'), 'export {};\n');
});

test('coding release: cancellation and late CLI completion cannot recreate a patch on the new claim', async () => {
  const entered = Promise.withResolvers<AbortSignal>();
  const finish = Promise.withResolvers<void>();
  const h = await releaseHarness({
    codingRun: async (options) => {
      entered.resolve(options.signal!);
      await finish.promise;
      return RESULT;
    },
  });
  await h.call(CHANNELS.codingStart, ID, { instruction: 'old claim' });
  const signal = await entered.promise;
  const runName = h.store.get(ID).codingRun!.runName;
  await releaseAndClaim(h);
  assert.equal(signal.aborted, true);
  finish.resolve();
  await h.idle();
  assert.equal(h.store.get(ID).status, 'in_progress');
  assert.equal(h.store.get(ID).mode, 'self');
  assert.equal(h.store.get(ID).codingRun, null);
  assert.ok(h.cleaned.includes(runName));
  assert.deepEqual((await h.call(CHANNELS.codingActive)).data, []);
  assert.equal((await h.call(CHANNELS.codingEvents, ID, -1)).error.code, 'coding_not_running');
  assert.equal(await fs.readFile(path.join(h.root, FILE), 'utf8'), 'export {};\n');
});

test('coding release: a workspace prepared after cancellation is cleaned instead of run', async () => {
  const entered = Promise.withResolvers<AbortSignal>();
  const finish = Promise.withResolvers<void>();
  let calls = 0;
  const h = await releaseHarness({
    codingPrepare: async (_root, _baseline, options) => {
      entered.resolve(options!.signal!);
      await finish.promise;
      return { runName: options!.runName!, directory: options!.runName! };
    },
    codingRun: async () => {
      calls += 1;
      return RESULT;
    },
  });
  await h.call(CHANNELS.codingStart, ID, { instruction: 'old claim' });
  const signal = await entered.promise;
  const runName = h.store.get(ID).codingRun!.runName;
  await releaseAndClaim(h);
  assert.equal(signal.aborted, true);
  finish.resolve();
  await h.idle();
  assert.equal(calls, 0);
  assert.equal(h.store.get(ID).codingRun, null);
  assert.ok(h.cleaned.includes(runName));
});

test('coding release: snapshot preparation cannot cross release and re-claim of the same baseline', async () => {
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  let calls = 0;
  const h = await releaseHarness({
    codingSnapshot: async (_root, baseline) => {
      entered.resolve();
      await finish.promise;
      return baseline;
    },
    codingRun: async () => {
      calls += 1;
      return RESULT;
    },
  });
  const starting = h.call(CHANNELS.codingStart, ID, { instruction: 'old claim' });
  await entered.promise;
  const baseline = h.store.get(ID).baseline;
  await releaseAndClaim(h);
  assert.equal(h.store.get(ID).baseline, baseline);
  finish.resolve();
  assert.equal((await starting).error.code, 'invalid_state');
  await h.idle();
  assert.equal(calls, 0);
  assert.equal(h.store.get(ID).codingRun, null);
});

test('coding release: apply already previewing the patch rechecks its claim before writing', async () => {
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  let hold = false;
  let writes = 0;
  const h = await releaseHarness({
    codingReadPatch: async () => {
      if (hold) {
        entered.resolve();
        await finish.promise;
      }
      return fixtures.filePatch(FILE, 'export const released = true;');
    },
    codingApplyPatch: async () => {
      writes += 1;
      return { written: [FILE], markers: [], kept: [] };
    },
  });
  await h.call(CHANNELS.codingStart, ID, { instruction: 'old claim' });
  await h.idle();
  const digest = await coding.reviewedDigest(h.call, ID);
  hold = true;
  const applying = h.call(CHANNELS.codingApply, ID, { digest, allowHighRisk: false, files: [FILE] });
  await entered.promise;
  await releaseAndClaim(h);
  finish.resolve();
  assert.equal((await applying).ok, false);
  await h.idle();
  assert.equal(writes, 0);
  assert.equal(h.store.get(ID).codingRun, null);
});

test('coding release: a blocked package refuses ready apply and marker resume', async () => {
  const h = await releaseHarness();
  await h.call(CHANNELS.codingStart, ID, { instruction: 'old claim' });
  await h.idle();
  const digest = await coding.reviewedDigest(h.call, ID);
  assert.equal((await h.call(CHANNELS.packagesTransition, ID, 'block')).ok, true);
  assert.equal((await h.call(CHANNELS.codingApply, ID, { digest, allowHighRisk: false, files: [FILE] })).error.code, 'coding_aborted');
  await h.store.updateCodingRun(ID, { status: 'applied', halt: 'markers' });
  assert.equal((await h.call(CHANNELS.codingResume, ID)).error.code, 'coding_aborted');
  assert.equal(await fs.readFile(path.join(h.root, FILE), 'utf8'), 'export {};\n');
});

test('coding release: running submit checks abort and cannot submit or retry on the new claim', async () => {
  const h = await coding.loopHarness();
  const marker = path.join(h.root, 'check-started');
  h.setCommands({
    test: { command: process.execPath, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started'); setInterval(() => {}, 1000);`] },
  });
  assert.equal((await coding.applyFirstRound(h)).ok, true);
  await until(
    () =>
      fs.access(marker).then(
        () => true,
        () => false,
      ),
    (started) => started,
    'coding submit check starts',
  );
  await releaseAndClaim(h);
  await h.idle();
  assert.equal(h.store.get(ID).status, 'in_progress');
  assert.equal(h.store.get(ID).codingRun, null);
  assert.equal(h.store.get(ID).review, null);
  assert.equal(h.prompts.length, 1);
  assert.deepEqual((await h.call(CHANNELS.codingActive)).data, []);
  const events = await h.activity.recent({ days: 1, limit: 100 });
  assert.equal(events.filter((event) => event.kind === 'package_transition' && event.transition === 'coding_submitted').length, 0);
});

test('coding release: marker review cannot resume after release and re-claim', async () => {
  const h = await releaseHarness({ codingApplyPatch: async () => ({ written: [FILE], markers: [FILE], kept: [] }) });
  await h.call(CHANNELS.codingStart, ID, { instruction: 'resolve conflict' });
  await h.idle();
  const digest = await coding.reviewedDigest(h.call, ID);
  assert.equal((await h.call(CHANNELS.codingApply, ID, { digest, allowHighRisk: false, files: [FILE] })).ok, true);
  assert.equal(h.store.get(ID).codingRun!.halt, 'markers');
  const runName = h.store.get(ID).codingRun!.runName;
  await releaseAndClaim(h);
  assert.equal((await h.call(CHANNELS.codingResume, ID)).error.code, 'coding_not_running');
  assert.ok(h.cleaned.includes(runName));
  await h.idle();
  assert.equal(h.store.get(ID).review, null);
});

test('coding release: an automatic apply held in patch reading cannot mutate a fresh coding round', async () => {
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const reads = new Map<string, number>();
  let round = 0;
  let writes = 0;
  let root = '';
  const h = await releaseHarness({
    codingRun: async () => {
      round += 1;
      return RESULT;
    },
    codingReadPatch: async (runName) => {
      const count = (reads.get(runName) ?? 0) + 1;
      reads.set(runName, count);
      const patch = fixtures.filePatch(FILE, `export const round = ${round};`);
      if (round === 2 && count === 2) {
        entered.resolve();
        await finish.promise;
      }
      return patch;
    },
    codingApplyPatch: async (_root, patch) => {
      writes += 1;
      await fs.writeFile(
        path.join(root, FILE),
        `${patch
          .split('\n')
          .find((line) => line.startsWith('+export'))!
          .slice(1)}\n`,
      );
      return { written: [FILE], markers: [], kept: [] };
    },
  });
  root = h.root!;
  h.setCommands({ test: coding.LOGIN_TESTS_FAIL });
  await h.call(CHANNELS.codingStart, ID, { instruction: 'old claim' });
  await h.idle();
  const digest = await coding.reviewedDigest(h.call, ID);
  assert.equal((await h.call(CHANNELS.codingApply, ID, { digest, allowHighRisk: false, files: [FILE] })).ok, true);
  await entered.promise;
  assert.equal(h.store.get(ID).codingRun!.attempt, 2);
  const oldRun = h.store.get(ID).codingRun!;
  await releaseAndClaim(h);
  assert.equal((await h.call(CHANNELS.codingStart, ID, { instruction: 'fresh round' })).ok, true);
  await until(
    () => h.store.get(ID).codingRun,
    (run) => run?.status === 'ready' && run.id !== oldRun.id,
    'fresh coding round is ready',
  );
  const fresh = h.store.get(ID).codingRun!;
  await assert.rejects(() => h.store.updateCodingRun(ID, { status: 'applied' }, oldRun.id), { code: 'invalid_state' });
  finish.resolve();
  await h.idle();
  assert.equal(writes, 1);
  assert.deepEqual(h.store.get(ID).codingRun, fresh);
  assert.equal(fresh.attempt, 1);
  assert.deepEqual(fresh.rounds, []);
  assert.equal(await fs.readFile(path.join(root, FILE), 'utf8'), 'export const round = 1;\n');
});

test('coding release: apply already inside the workspace writer rechecks before touching the working tree', async () => {
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const h = await releaseHarness({
    codingApplyPatch: async (...args) => {
      entered.resolve();
      await finish.promise;
      return applyPatch(...args);
    },
  });
  await h.call(CHANNELS.codingStart, ID, { instruction: 'old claim' });
  await h.idle();
  const digest = await coding.reviewedDigest(h.call, ID);
  const applying = h.call(CHANNELS.codingApply, ID, { digest, allowHighRisk: false, files: [FILE] });
  await entered.promise;
  assert.equal(h.store.get(ID).codingRun!.status, 'applying');
  await releaseAndClaim(h);
  finish.resolve();
  assert.equal((await applying).error.code, 'coding_aborted');
  await h.idle();
  assert.equal(await fs.readFile(path.join(h.root, FILE), 'utf8'), 'export {};\n');
  assert.equal(h.store.get(ID).codingRun, null);
  assert.equal(h.store.get(ID).review, null);
});
