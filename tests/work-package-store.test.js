const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { WorkPackageStore, STATE_FILENAME } = require('../src/work-package-store');

const SAMPLE = [
  { id: 'a', status: 'pending', steps: ['one', 'two'] },
  { id: 'b', status: 'clarifying', steps: ['one'] },
];

async function newStore(dir) {
  const configDir = dir ?? await fs.mkdtemp(path.join(os.tmpdir(), 'taskpilot-store-'));
  if (!dir) test.after(() => fs.rm(configDir, { recursive: true, force: true }));
  return { store: await new WorkPackageStore(configDir).load(SAMPLE), configDir };
}

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
  assert.match(entry.claimedAt, /^\d{4}-\d{2}-\d{2}T/);
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
  await assert.rejects(
    () => store.transition('a', 'report_deviation', 'human', { deviation: { note: '  ' } }),
    { code: 'deviation_note_required' },
  );
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
  await assert.rejects(() => store.setStepDone('a', 'x', true), { code: 'invalid_step' });
});

test('state survives a reload from disk', async () => {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'taskpilot-store-'));
  test.after(() => fs.rm(configDir, { recursive: true, force: true }));
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
  test.after(() => fs.rm(configDir, { recursive: true, force: true }));
  await fs.writeFile(path.join(configDir, STATE_FILENAME), '{ broken');
  const { store } = await newStore(configDir);
  assert.equal(store.get('a').status, 'pending');
});

test('saved entries for unknown ids or unknown statuses are ignored', async () => {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'taskpilot-store-'));
  test.after(() => fs.rm(configDir, { recursive: true, force: true }));
  await fs.writeFile(path.join(configDir, STATE_FILENAME), JSON.stringify({
    removed: { status: 'done' },
    a: { status: 'not_a_real_status' },
  }));
  const { store } = await newStore(configDir);
  assert.throws(() => store.get('removed'), { code: 'unknown_package' });
  assert.equal(store.get('a').status, 'pending');
});
