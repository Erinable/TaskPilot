import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tempDir } from '../../fixtures/temp_dir.ts';
import { RequirementStore, REQUIREMENTS_FILENAME } from '../../../src/main/requirements/requirement_store.ts';

import type { TaskDefinition } from '../../../src/main/work_packages/tasks.ts';
import type { Plan } from '../../../src/main/agents/product_lead.ts';
import type { CoursePlan } from '../../../src/shared/course_plan.ts';
import type { CoursePack } from '../../../src/shared/course_pack.ts';
const newStore = async (dir?: string) => {
  const configDir = dir ?? (await tempDir('taskpilot-req-'));
  let n = 0;
  let t = 0;
  const store = await new RequirementStore(configDir, {
    newId: () => `req-${++n}`,
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, t++)),
  }).load();
  return { store, configDir };
};

const clarified = { title: '邮箱登录', summary: '用户用邮箱登录', questions: ['锁定策略？', '要记住我吗？'] };
// Deliberately minimal plan fixture: the store keeps packages as given.
const plan = { summary: 'p', packages: [{ title: 'a' }] } as unknown as Plan;

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
  assert.deepEqual(
    item.questions.map((q) => q.answer),
    ['', ''],
  );

  item = await store.setAnswers(id, ['5 次', '']);
  assert.equal(item.questions[0].answer, '5 次');

  await store.begin(id, 'planning');
  item = await store.finishPlan(id, plan, 0.1);
  assert.equal(item.status, 'reviewing');
  assert.ok(Math.abs(item.costUsd - 0.15) < 1e-9);

  // Deliberately invalid minimal task fixture for catalog behavior.
  item = await store.publish(id, [{ id: `${id}-wp1` } as unknown as TaskDefinition]);
  assert.equal(item.status, 'published');
  assert.deepEqual(
    store.listTasks().map((p) => p.id),
    ['req-1-wp1'],
  );
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
  assert.deepEqual(
    store.list().map((r) => r.text),
    ['second', 'first'],
  );
  const { store: reloaded } = await newStore(configDir);
  assert.equal(reloaded.list().length, 2);

  await fs.writeFile(path.join(configDir, REQUIREMENTS_FILENAME), '{ nope');
  const { store: empty } = await newStore(configDir);
  assert.deepEqual(empty.list(), []);
});

// Runs a requirement up to reviewing, ready to publish.
const reviewing = async (store: RequirementStore, text: string) => {
  const { id } = await store.create({ text });
  await store.begin(id, 'clarifying');
  await store.finishClarify(id, clarified, 0);
  await store.begin(id, 'planning');
  await store.finishPlan(id, plan, 0);
  return id;
};

test('the catalog follows publish, remove and open, oldest requirement first', async () => {
  const { store, configDir } = await newStore();
  assert.deepEqual(store.listTasks(), []);
  const first = await reviewing(store, 'a');
  const second = await reviewing(store, 'b');
  const draft = await store.create({ text: 'c' });
  // Deliberately invalid minimal task fixtures for catalog ordering behavior.
  await store.publish(second, [{ id: 'b-wp1', requirementId: second } as unknown as TaskDefinition]);
  await store.publish(first, [{ id: 'a-wp1', requirementId: first } as unknown as TaskDefinition]);
  assert.deepEqual(
    store.listTasks().map((task) => task.id),
    ['a-wp1', 'b-wp1'],
  );
  assert.equal(store.getTask('b-wp1')?.requirementId, second);
  assert.equal(store.getTask('nope'), null);

  // Removing an unpublished requirement leaves the published ones.
  await store.remove(draft.id);
  assert.equal(store.listTasks().length, 2);

  // Another repository has its own catalog; reopening restores this one.
  const other = await tempDir('taskpilot-req-');
  await store.open(other);
  assert.deepEqual(store.listTasks(), []);
  await store.open(configDir);
  assert.deepEqual(
    store.listTasks().map((task) => task.id),
    ['a-wp1', 'b-wp1'],
  );
});

test('catalog reads share frozen definitions that callers cannot change', async () => {
  const { store } = await newStore();
  const id = await reviewing(store, 'a');
  // Deliberately invalid minimal task fixture for frozen catalog behavior.
  await store.publish(id, [{ id: 'a-wp1', title: 't', steps: ['s'] } as unknown as TaskDefinition]);
  assert.equal(store.listTasks(), store.listTasks(), 'no copy per read');
  const task = store.getTask('a-wp1')!;
  assert.throws(() => {
    (task as { title: string }).title = 'mutated';
  }, TypeError);
  assert.throws(() => (task.steps as string[]).push('extra'), TypeError);
  // The stored requirement is not frozen with it.
  const saved = store.get(id);
  saved.packages[0].title = 'edited copy';
  assert.equal(store.getTask('a-wp1')?.title, 't');
});

// ========== Course requirements ==========
const FORM = { level: 'basic', target: 'implement', toolchain: 'c', environment: 'macOS', weeklyHours: 4 } as const;
const pick = { course: 'os', reason: 'fits', options: [{ id: 'os', title: '操作系统实验' }] };
const coursePlan: CoursePlan = {
  course: { id: 'os', version: '0.2.0', contentHash: 'h', source: 'builtin' },
  goal: { kind: 'course', goal: '调度', ...FORM, knownConcepts: [] },
  summary: 's',
  path: [
    { conceptId: 'fcfs', status: 'planned' },
    { conceptId: 'round-robin', status: 'planned' },
  ],
  extraConcepts: [],
};

test('a course requirement runs the interview, the path and its confirmation; projects keep no course fields', async () => {
  const { store, configDir } = await newStore();
  const project = await store.create({ text: '登录' });
  assert.equal('kind' in project, false);
  assert.equal('course' in project, false);

  const { id } = await store.create({ text: '想学调度', course: FORM });
  assert.equal(store.get(id).kind, 'course');
  await store.begin(id, 'clarifying');
  let item = await store.finishCourseClarify(id, { title: '调度', summary: 's', questions: ['多核？'], pick }, 0.01);
  assert.equal(item.status, 'answering');
  assert.deepEqual(item.course!.pick, pick);
  await assert.rejects(() => store.finishCourseClarify(project.id, { title: 't', summary: 's', questions: [], pick }), { code: 'invalid_state' });

  await store.setAnswers(id, ['先不用']);
  await store.setCourseChoice(id, { course: 'os' });
  await store.begin(id, 'planning');
  item = await store.finishCoursePlan(id, coursePlan, [], 0.02);
  assert.equal(item.status, 'reviewing');
  item = await store.setCoursePath(id, [
    { conceptId: 'fcfs', status: 'known' },
    { conceptId: 'round-robin', status: 'planned' },
  ]);
  assert.deepEqual(item.course!.plan!.goal.knownConcepts, ['fcfs']);
  item = await store.confirmCoursePath(id);
  assert.equal(item.status, 'published');
  assert.deepEqual(store.listTasks(), [], 'a confirmed path adds nothing to the queue');

  const reloaded = (await newStore(configDir)).store;
  assert.equal(reloaded.get(id).course!.plan!.path[0].status, 'known');
});

test('editing answers drops a course path or draft, and a saved draft becomes the choice', async () => {
  const { store } = await newStore();
  const { id } = await store.create({ text: '想学词法分析', course: FORM });
  await store.begin(id, 'clarifying');
  await store.finishCourseClarify(id, { title: '词法', summary: 's', questions: [], pick: { ...pick, course: null } });
  await store.setCourseChoice(id, { draft: true });
  await store.begin(id, 'planning');
  // Deliberately invalid course pack fixture for draft persistence behavior.
  let item = await store.finishCourseDraft(id, { pack: { id: 'lexing' } as unknown as CoursePack, contentHash: 'h' });
  assert.equal(item.course!.draft!.contentHash, 'h');
  item = await store.useCourseDraft(id, { id: 'lexing', title: '词法分析' });
  assert.deepEqual(item.course!.choice, { course: 'lexing' });
  assert.equal(item.course!.draft, null);
  assert.deepEqual(item.course!.pick!.options.at(-1), { id: 'lexing', title: '词法分析' });

  await store.begin(id, 'planning');
  await store.finishCoursePlan(id, coursePlan, []);
  item = await store.setAnswers(id, []);
  assert.equal(item.status, 'answering');
  assert.equal(item.course!.plan, null);
});

test('a course run interrupted by quitting names Tutor', async () => {
  const { store, configDir } = await newStore();
  const { id } = await store.create({ text: '想学', course: FORM });
  await store.begin(id, 'clarifying');
  const reloaded = (await newStore(configDir)).store;
  assert.match(reloaded.get(id).error!.message, /Tutor/);
});

test('load infers an unambiguous legacy course toolchain in the form and plan', async () => {
  const { store, configDir } = await newStore();
  const legacyForm = { level: 'basic' as const, target: 'implement' as const, environment: 'macos,rust', weeklyHours: 4 };
  const { id } = await store.create({ text: '想学 Rust', course: legacyForm });
  await store.begin(id, 'clarifying');
  await store.finishCourseClarify(id, { title: 'Rust', summary: 's', questions: [], pick });
  await store.setCourseChoice(id, { course: 'os' });
  await store.begin(id, 'planning');
  await store.finishCoursePlan(
    id,
    {
      ...coursePlan,
      goal: { kind: 'course', goal: '调度', level: 'basic', target: 'implement', environment: 'macos,rust', weeklyHours: 4, knownConcepts: [] },
    },
    [],
  );
  const ambiguous = await store.create({ text: '想学多工具', course: { ...legacyForm, environment: 'c,rust' } });

  const reloaded = (await newStore(configDir)).store;
  assert.equal(reloaded.get(id).course!.form.toolchain, 'rust');
  assert.equal(reloaded.get(id).course!.plan!.goal.toolchain, 'rust');
  assert.equal(reloaded.get(ambiguous.id).course!.form.toolchain, undefined);
});
