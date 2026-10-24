import { test, onTestFinished } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkPackageStore, STATE_FILENAME, humanTransitions } from '../../src/main/work_package_store.ts';

const SAMPLE: any[] = [
  { id: 'a', status: 'pending', steps: ['one', 'two'] },
  { id: 'b', status: 'clarifying', steps: ['one'] },
];

const newStore = async (dir?: string) => {
  const configDir = dir ?? (await fs.mkdtemp(path.join(os.tmpdir(), 'taskpilot-store-')));
  if (!dir) onTestFinished(() => fs.rm(configDir, { recursive: true, force: true }));
  return { store: await new WorkPackageStore(configDir).load(SAMPLE), configDir };
};

test('seeds state from the task definitions', async () => {
  const { store } = await newStore();
  assert.equal(store.get('a').status, 'pending');
  assert.equal(store.get('b').status, 'clarifying');
  assert.equal(store.get('a').baseline, null);
  assert.deepEqual(store.get('a').completedSteps, []);
});

test('rejects an unknown package id', async () => {
  const { store } = await newStore();
  assert.throws(() => store.get('nope'), { code: 'unknown_package' });
});

test('get() and all() return copies the caller cannot mutate', async () => {
  const { store } = await newStore();
  store.get('a').completedSteps.push(99);
  store.all().a.status = 'done';
  assert.deepEqual(store.get('a').completedSteps, []);
  assert.equal(store.get('a').status, 'pending');
});

test('claiming records a baseline commit and a timestamp', async () => {
  const { store } = await newStore();
  const entry = await store.transition('a', 'claim', 'human', { baseline: 'abc123' });
  assert.equal(entry.status, 'in_progress');
  assert.equal(entry.baseline, 'abc123');
  assert.match(entry.claimedAt!, /^\d{4}-\d{2}-\d{2}T/);
});

test('claiming without a baseline is refused', async () => {
  const { store } = await newStore();
  await assert.rejects(() => store.transition('a', 'claim', 'human'), { code: 'baseline_required' });
});

test('releasing clears the baseline and step progress', async () => {
  const { store } = await newStore();
  await store.transition('a', 'claim', 'human', { baseline: 'abc123' });
  await store.setStepDone('a', 0, true);
  const entry = await store.transition('a', 'release', 'human');
  assert.equal(entry.status, 'pending');
  assert.equal(entry.baseline, null);
  assert.deepEqual(entry.completedSteps, []);
});

test('a deviation report needs a note and is recorded with a timestamp', async () => {
  const { store } = await newStore();
  await store.transition('a', 'claim', 'human', { baseline: 'abc123' });
  await assert.rejects(() => store.transition('a', 'report_deviation', 'human', { deviation: { note: '  ' } }), { code: 'deviation_note_required' });
  const entry = await store.transition('a', 'report_deviation', 'human', {
    deviation: { note: 'ADR-014 和现有代码冲突', stepIndex: 1, filePath: 'src/x.ts' },
  });
  assert.equal(entry.status, 'deviation');
  assert.equal(entry.deviations.length, 1);
  assert.equal(entry.deviations[0].stepIndex, 1);
  assert.equal(entry.deviations[0].filePath, 'src/x.ts');
});

test('the status machine still governs transitions through the store', async () => {
  const { store } = await newStore();
  // 'a' is pending, so it cannot be submitted for review yet.
  await assert.rejects(() => store.transition('a', 'submit_for_review', 'human'), { code: 'not_allowed' });
  await assert.rejects(() => store.transition('a', 'claim', 'agent', { baseline: 'x' }), { code: 'wrong_actor' });
});

test('setStepDone() toggles and keeps indices sorted and unique', async () => {
  const { store } = await newStore();
  await store.setStepDone('a', 1, true);
  await store.setStepDone('a', 0, true);
  await store.setStepDone('a', 1, true); // repeat
  assert.deepEqual(store.get('a').completedSteps, [0, 1]);
  await store.setStepDone('a', 0, false);
  assert.deepEqual(store.get('a').completedSteps, [1]);
});

test('setStepDone() rejects a non-integer index', async () => {
  const { store } = await newStore();
  await assert.rejects(() => store.setStepDone('a', -1, true), { code: 'invalid_step' });
  await assert.rejects(() => store.setStepDone('a', 'x' as any, true), { code: 'invalid_step' });
});

test('state survives a reload from disk', async () => {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'taskpilot-store-'));
  onTestFinished(() => fs.rm(configDir, { recursive: true, force: true }));
  const { store } = await newStore(configDir);
  await store.transition('a', 'claim', 'human', { baseline: 'abc123' });
  await store.setStepDone('a', 0, true);

  const { store: reloaded } = await newStore(configDir);
  assert.equal(reloaded.get('a').status, 'in_progress');
  assert.equal(reloaded.get('a').baseline, 'abc123');
  assert.deepEqual(reloaded.get('a').completedSteps, [0]);
});

test('a corrupt state file falls back to seeded defaults', async () => {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'taskpilot-store-'));
  onTestFinished(() => fs.rm(configDir, { recursive: true, force: true }));
  await fs.writeFile(path.join(configDir, STATE_FILENAME), '{ broken');
  const { store } = await newStore(configDir);
  assert.equal(store.get('a').status, 'pending');
});

test('reset() returns every package to its seed state and removes the file', async () => {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'taskpilot-store-'));
  onTestFinished(() => fs.rm(configDir, { recursive: true, force: true }));
  const { store } = await newStore(configDir);
  await store.transition('a', 'claim', 'human', { baseline: 'abc123' });
  await store.transition('a', 'report_deviation', 'human', { deviation: { note: 'x' } });
  assert.deepEqual(store.summary(), { total: 2, claimed: 1, deviations: 1 });

  await store.reset();
  assert.equal(store.get('a').status, 'pending');
  assert.equal(store.get('a').baseline, null);
  assert.deepEqual(store.summary(), { total: 2, claimed: 0, deviations: 0 });
  await assert.rejects(() => fs.access(path.join(configDir, STATE_FILENAME)));

  const { store: reloaded } = await newStore(configDir);
  assert.equal(reloaded.get('a').status, 'pending');
});

test('saved entries for unknown ids or unknown statuses are ignored', async () => {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'taskpilot-store-'));
  onTestFinished(() => fs.rm(configDir, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(configDir, STATE_FILENAME),
    JSON.stringify({
      removed: { status: 'done' },
      a: { status: 'not_a_real_status' },
    }),
  );
  const { store } = await newStore(configDir);
  assert.throws(() => store.get('removed'), { code: 'unknown_package' });
  assert.equal(store.get('a').status, 'pending');
});

/* QA review */

const inReview = async (store, id = 'a') => {
  await store.transition(id, 'claim', 'human', { baseline: 'abc123' });
  await store.transition(id, 'submit_for_review', 'human');
};
const reviewResult = (passed: boolean): any => ({
  passed,
  reasons: passed ? [] : ['qa_rejected'],
  verification: null,
  acceptance: [],
  report: { verdict: passed ? 'pass' : 'reject', summary: 's', criteria: [], issues: [] },
  diff: { files: [], skipped: [], outOfScope: [] },
  costUsd: 0.01,
});

test('a clean pass goes straight to done; a pass with attention waits for the human', async () => {
  const { store } = await newStore();
  await assert.rejects(() => store.beginReview('a'), { code: 'invalid_state' });
  await inReview(store);
  const running = await store.beginReview('a');
  assert.equal(running.review!.status, 'running');
  await assert.rejects(() => store.beginReview('a'), { code: 'review_running' });

  const done = await store.completeReview('a', reviewResult(true));
  assert.equal(done.status, 'done');
  assert.equal(done.review!.status, 'passed');
  assert.equal(done.review!.costUsd, 0.01);
  await assert.rejects(() => store.completeReview('a', reviewResult(true)), { code: 'review_not_running' });

  const { store: other } = await newStore();
  await inReview(other);
  await other.beginReview('a');
  const waiting = await other.completeReview('a', { ...reviewResult(true), attention: [{ kind: 'test', reason: 'no_baseline' } as any] });
  assert.equal(waiting.status, 'accepting');
  assert.deepEqual(humanTransitions(waiting).sort(), ['acceptance_rejected', 'accepted']);
  const accepted = await other.transition('a', 'accepted', 'human');
  assert.equal(accepted.status, 'done');
  assert.equal(accepted.review!.humanVerdict, 'accepted');
});

/* Deviation adjudication */

const dismissal: any = { decision: 'dismiss', reason: '用 `findByEmail()` 即可', changes: [], revision: null, read: ['src/x.ts'], skipped: [], costUsd: 0.02 };
const replan: any = {
  decision: 'replan',
  reason: '接口已改名',
  changes: ['步骤 2 改用 `findUser()`'],
  revision: { steps: ['新步骤'], fileScope: ['src/y.ts'], acceptance: [{ text: '新条件' }] },
  read: [],
  skipped: [],
  costUsd: 0.03,
};

const inDeviation = async (store) => {
  await store.transition('a', 'claim', 'human', { baseline: 'c1' });
  await store.setStepDone('a', 0, true);
  await store.transition('a', 'report_deviation', 'human', { deviation: { note: '接口不存在' } });
  await store.beginAdjudication('a');
};

test('a dismissal returns the package with progress intact and can be contested once', async () => {
  const { store } = await newStore();
  await assert.rejects(() => store.beginAdjudication('a'), { code: 'invalid_state' });
  await inDeviation(store);
  await assert.rejects(() => store.beginAdjudication('a'), { code: 'adjudication_running' });

  const dismissed = await store.completeAdjudication('a', dismissal);
  assert.equal(dismissed.status, 'in_progress');
  assert.equal(dismissed.baseline, 'c1');
  assert.deepEqual(dismissed.completedSteps, [0]);
  assert.equal(dismissed.deviations[0].resolution!.decision, 'dismiss');
  assert.ok(humanTransitions(dismissed).includes('override_dismissal'));

  const contested = await store.transition('a', 'override_dismissal', 'human');
  assert.equal(contested.status, 'deviation');
  assert.equal(contested.deviations[0].resolution!.contested, true);
  const rerun = await store.beginAdjudication('a');
  assert.equal(rerun.adjudication!.mustReplan, true);
  // Architect cannot dismiss the same deviation twice.
  await assert.rejects(() => store.completeAdjudication('a', dismissal), { code: 'invalid_state' });
  const replanned = await store.completeAdjudication('a', replan);
  assert.equal(replanned.deviations[0].resolution!.afterContest, true);
  assert.ok(!humanTransitions({ ...replanned, status: 'in_progress' }).includes('override_dismissal'));
});

test('a replan swaps the definition, resets execution, and can be reverted until claimed', async () => {
  const { store, configDir } = await newStore();
  await inDeviation(store);
  const replanned = await store.completeAdjudication('a', replan);
  assert.equal(replanned.status, 'pending');
  assert.equal(replanned.baseline, null);
  assert.deepEqual(replanned.completedSteps, []);
  assert.equal(replanned.revision!.version, 1);
  assert.deepEqual(store.effective(SAMPLE[0]).steps, ['新步骤']);
  assert.deepEqual(store.effective(SAMPLE[0]).fileScope, ['src/y.ts']);
  assert.ok(humanTransitions(replanned).includes('revert_replan'));

  // The revision survives a restart.
  const { store: reloaded } = await newStore(configDir);
  assert.deepEqual(reloaded.effective(SAMPLE[0]).steps, ['新步骤']);

  const reverted = await store.transition('a', 'revert_replan', 'human');
  assert.equal(reverted.status, 'in_progress');
  assert.equal(reverted.baseline, 'c1');
  assert.deepEqual(reverted.completedSteps, [0]);
  assert.equal(reverted.revision, null);
  assert.equal(reverted.deviations[0].resolution!.reverted, true);
  assert.deepEqual(store.effective(SAMPLE[0]).steps, ['one', 'two']);
  await assert.rejects(() => store.transition('a', 'revert_replan', 'human'), { code: 'not_allowed' });
});

test('claiming a replanned package drops the undo', async () => {
  const { store } = await newStore();
  await inDeviation(store);
  await store.completeAdjudication('a', replan);
  const claimed = await store.transition('a', 'claim', 'human', { baseline: 'c2' });
  assert.equal(claimed.replanUndo, null);
  await store.transition('a', 'release', 'human');
  await assert.rejects(() => store.transition('a', 'revert_replan', 'human'), { code: 'invalid_state' });
});

test('a failed adjudication keeps the deviation, and an interrupted one fails on reload', async () => {
  const { store, configDir } = await newStore();
  await inDeviation(store);
  const { store: reloaded } = await newStore(configDir);
  assert.equal(reloaded.get('a').adjudication!.status, 'failed');
  assert.equal(reloaded.get('a').adjudication!.error!.code, 'agent_interrupted');

  const failed = await store.failAdjudication('a', Object.assign(new Error('boom'), { code: 'agent_timeout' }));
  assert.equal(failed.status, 'deviation');
  assert.equal(failed.adjudication!.error!.code, 'agent_timeout');
});

test('a rejected review sends the package back and keeps the report', async () => {
  const { store } = await newStore();
  await inReview(store);
  await store.beginReview('a');
  const done = await store.completeReview('a', reviewResult(false));
  assert.equal(done.status, 'in_progress');
  assert.equal(done.review!.status, 'rejected');
  assert.equal(done.baseline, 'abc123');
  // Releasing the package discards the old review.
  assert.equal((await store.transition('a', 'release', 'human')).review, null);
});

test('a failed review leaves the package in review, and an interrupted one fails on reload', async () => {
  const { store, configDir } = await newStore();
  await inReview(store);
  await store.beginReview('a');
  const failed = await store.failReview('a', Object.assign(new Error('boom'), { code: 'agent_timeout' }));
  assert.equal(failed.status, 'in_review');
  assert.deepEqual(failed.review!.error, { code: 'agent_timeout', message: 'boom' });

  await store.beginReview('a');
  const { store: reloaded } = await newStore(configDir);
  assert.equal(reloaded.get('a').review!.status, 'failed');
  assert.equal(reloaded.get('a').review!.error!.code, 'agent_interrupted');
});

test('setBaselineChecks() records only for the claimed commit and clears on release', async () => {
  const { store, configDir } = await newStore();
  await store.transition('a', 'claim', 'human', { baseline: 'c1' });
  assert.equal(await store.setBaselineChecks('a', { status: 'measured', commit: 'other', checks: {} } as any), null);
  const saved = await store.setBaselineChecks('a', { status: 'measuring', commit: 'c1', checks: {} } as any);
  assert.equal(saved!.baselineChecks!.status, 'measuring');
  await assert.rejects(() => store.setBaselineChecks('a', { status: 'bogus', commit: 'c1' } as any), { code: 'invalid_argument' });

  // A measurement in flight when the app closed is not trusted on reload.
  const reloaded = await new WorkPackageStore(configDir).load(SAMPLE);
  assert.equal(reloaded.get('a').baselineChecks!.status, 'unavailable');
  assert.equal(reloaded.get('a').baselineChecks!.reason, 'interrupted');

  await store.transition('a', 'release', 'human');
  assert.equal(store.get('a').baselineChecks, null);
});

test('the execution mode is set at claim, cleared on release and replan, and restored on revert', async () => {
  const { store, configDir } = await newStore();
  assert.equal(store.get('a').mode, null);
  assert.equal((await store.transition('a', 'claim', 'human', { baseline: 'c1', mode: 'practice' })).mode, 'practice');
  const { store: reloaded } = await newStore(configDir);
  assert.equal(reloaded.get('a').mode, 'practice');
  assert.equal((await store.transition('a', 'release', 'human')).mode, null);

  await store.transition('a', 'claim', 'human', { baseline: 'c1', mode: 'ai' });
  await store.transition('a', 'report_deviation', 'human', { deviation: { note: '接口不存在' } });
  await store.beginAdjudication('a');
  assert.equal((await store.completeAdjudication('a', replan)).mode, null);
  assert.equal((await store.transition('a', 'revert_replan', 'human')).mode, 'ai');
});
