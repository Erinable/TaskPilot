import { test, onTestFinished } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RequirementStore, REQUIREMENTS_FILENAME } from '../../src/main/requirement_store.ts';

async function newStore(dir?: string) {
  const configDir = dir ?? await fs.mkdtemp(path.join(os.tmpdir(), 'taskpilot-req-'));
  if (!dir) onTestFinished(() => fs.rm(configDir, { recursive: true, force: true }));
  let n = 0;
  let t = 0;
  const store = await new RequirementStore(configDir, {
    newId: () => `req-${++n}`,
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, t++)),
  }).load();
  return { store, configDir };
}

const clarified = { title: '邮箱登录', summary: '用户用邮箱登录', questions: ['锁定策略？', '要记住我吗？'] };
const plan: any = { summary: 'p', packages: [{ title: 'a' }] };

test('create() validates text and starts in draft', async () => {
  const { store } = await newStore();
  await assert.rejects(() => store.create({ text: '   ' }), { code: 'required', field: 'text' });
  await assert.rejects(() => store.create({ text: 'x'.repeat(4001) }), { code: 'too_long', field: 'text' });
  await assert.rejects(() => store.create({ text: 'a\u0000b' }), { code: 'invalid_text' });
  const item = await store.create({ text: ' 登录 ' });
  assert.equal(item.status, 'draft');
  assert.equal(item.text, '登录');
});

test('the full flow: clarify, answer, plan, publish', async () => {
  const { store } = await newStore();
  const { id } = await store.create({ text: '登录' });
  await store.begin(id, 'clarifying');
  let item = await store.finishClarify(id, clarified, 0.05);
  assert.equal(item.status, 'answering');
  assert.equal(item.title, '邮箱登录', 'agent title fills an empty user title');
  assert.deepEqual(item.questions.map((q) => q.answer), ['', '']);

  item = await store.setAnswers(id, ['5 次', '']);
  assert.equal(item.questions[0].answer, '5 次');

  await store.begin(id, 'planning');
  item = await store.finishPlan(id, plan, 0.1);
  assert.equal(item.status, 'reviewing');
  assert.ok(Math.abs(item.costUsd - 0.15) < 1e-9);

  item = await store.publish(id, [{ id: `${id}-wp1` } as any]);
  assert.equal(item.status, 'published');
  assert.deepEqual(store.publishedPackages().map((p) => p.id), ['req-1-wp1']);
});

test('a user-supplied title is kept over the agent title', async () => {
  const { store } = await newStore();
  const { id } = await store.create({ title: '我的标题', text: 't' });
  await store.begin(id, 'clarifying');
  assert.equal((await store.finishClarify(id, clarified)).title, '我的标题');
});

test('steps refuse to run from the wrong state', async () => {
  const { store } = await newStore();
  const { id } = await store.create({ text: 't' });
  await assert.rejects(() => store.begin(id, 'planning'), { code: 'invalid_state' });
  await store.begin(id, 'clarifying');
  await assert.rejects(() => store.begin(id, 'clarifying'), { code: 'invalid_state' }, 'no double run');
  await assert.rejects(() => store.publish(id, []), { code: 'invalid_state' });
  await assert.rejects(() => store.remove(id), { code: 'invalid_state' });
});

test('answers must match the questions and are length-limited', async () => {
  const { store } = await newStore();
  const { id } = await store.create({ text: 't' });
  await store.begin(id, 'clarifying');
  await store.finishClarify(id, clarified);
  await assert.rejects(() => store.setAnswers(id, ['one']), { field: 'answers' });
  await assert.rejects(() => store.setAnswers(id, ['x'.repeat(1001), '']), { code: 'too_long' });
});

test('editing answers after planning discards the plan', async () => {
  const { store } = await newStore();
  const { id } = await store.create({ text: 't' });
  await store.begin(id, 'clarifying');
  await store.finishClarify(id, clarified);
  await store.begin(id, 'planning');
  await store.finishPlan(id, plan);
  const item = await store.setAnswers(id, ['a', 'b']);
  assert.equal(item.status, 'answering');
  assert.equal(item.plan, null);
});

test('a failed run records the step and can be retried', async () => {
  const { store } = await newStore();
  const { id } = await store.create({ text: 't' });
  await store.begin(id, 'clarifying');
  let item = await store.failRun(id, 'clarifying', { code: 'agent_timeout', message: 'slow' });
  assert.equal(item.status, 'failed');
  assert.equal(item.failedStep, 'clarifying');
  await assert.rejects(() => store.begin(id, 'planning'), { code: 'invalid_state' }, 'cannot plan before clarifying');
  item = await store.begin(id, 'clarifying');
  assert.equal(item.error, null);
});

test('a run interrupted by quitting loads as failed', async () => {
  const { store, configDir } = await newStore();
  const { id } = await store.create({ text: 't' });
  await store.begin(id, 'clarifying');
  const { store: reloaded } = await newStore(configDir);
  const item = reloaded.get(id);
  assert.equal(item.status, 'failed');
  assert.equal(item.error!.code, 'agent_interrupted');
});

test('concurrent writes do not collide on the temp file', async () => {
  // Regression: a background agent run and a user edit saving at once both
  // renamed the same temp file, and one failed with ENOENT.
  const { store, configDir } = await newStore();
  await Promise.all(Array.from({ length: 20 }, (_, i) => store.create({ text: `r${i}` })));
  const { store: reloaded } = await newStore(configDir);
  assert.equal(reloaded.list().length, 20);
});

test('list() is newest first and survives a reload; corrupt files load empty', async () => {
  const { store, configDir } = await newStore();
  await store.create({ text: 'first' });
  await store.create({ text: 'second' });
  assert.deepEqual(store.list().map((r) => r.text), ['second', 'first']);
  const { store: reloaded } = await newStore(configDir);
  assert.equal(reloaded.list().length, 2);

  await fs.writeFile(path.join(configDir, REQUIREMENTS_FILENAME), '{ nope');
  const { store: empty } = await newStore(configDir);
  assert.deepEqual(empty.list(), []);
});
