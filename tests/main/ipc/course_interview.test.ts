/** @module-tag integration */
// Course requirements over the requirement channels: Tutor's goal
// interview, the learning path and the drafted pack
// (src/main/requirements/course_interview_service.ts).
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { CHANNELS } from '../../../src/shared/ipc_channels.ts';
import * as fixtures from './harness.ts';
import * as goals from '../../fixtures/course_interview.ts';
import { captureExpectedErrors } from '../../fixtures/expected_errors.ts';

type Step = 'interview' | 'path' | 'draft';
const interviewStep = (schema): Step => (schema.properties.course ? 'interview' : schema.properties.path ? 'path' : 'draft');

// A fake Tutor answering the interview's three steps.
const tutor =
  (answers: Partial<Record<Step, unknown | unknown[]>> = {}) =>
  async ({ schema }) => {
    const step = interviewStep(schema);
    const answer = answers[step] ?? { interview: goals.SCHEDULING_CLARIFY, path: goals.SCHEDULING_PATH, draft: goals.LEXING_DRAFT }[step];
    // A list answers successive calls of that step.
    const output = Array.isArray(answer) ? answer.shift() : answer;
    return { output, costUsd: 0.01 };
  };

const createCourse = async (h, text: string) => {
  const { data, error } = await h.call(CHANNELS.requirementsCreate, { text, course: goals.GOAL_FORM });
  assert.equal(error, undefined);
  await h.idle();
  return (await h.call(CHANNELS.requirementsGet, data.id)).data;
};

test('course: 想学操作系统的进程调度 picks os, plans a path through its scheduling skeleton and confirms it', async () => {
  const h = await fixtures.harness({ agent: tutor() });
  let item = await createCourse(h, '想学操作系统的进程调度');
  assert.equal(item.kind, 'course');
  assert.equal(item.status, 'answering');
  assert.equal(item.course.pick.course, 'os');
  assert.deepEqual(
    item.course.pick.options.map((option) => option.id),
    ['os'],
    'only trusted packs with a skeleton are offered',
  );
  assert.deepEqual(item.questions, [{ text: '想不想接触多核调度？', answer: '' }]);
  // Tutor saw the form and the os skeleton, never a repository file.
  const interviewCall = h.agentCalls[0];
  assert.match(interviewCall.prompt, /Environment: macOS，本机 C 编译器/);
  assert.match(interviewCall.prompt, /- mlfq: /);
  assert.doesNotMatch(interviewCall.prompt, /login-user/);
  assert.equal(h.agentCalls.length, 1, 'no Architect run for a course');

  await h.call(CHANNELS.requirementsPlan, item.id, ['先不用'], { course: 'os' });
  await h.idle();
  item = (await h.call(CHANNELS.requirementsGet, item.id)).data;
  assert.equal(item.status, 'reviewing');
  assert.match(h.agentCalls[1].prompt, /A1: 先不用/);
  const plan = item.course.plan;
  assert.equal(plan.course.id, 'os');
  assert.equal(plan.course.source, 'builtin');
  assert.deepEqual(plan.goal, { kind: 'course', goal: '想学操作系统的进程调度', ...goals.GOAL_FORM, knownConcepts: ['process-state'] });
  const ids = plan.path.map((entry) => entry.conceptId);
  assert.ok(ids.includes('round-robin') && ids.includes('mlfq') && !ids.includes('multicore-sched'));
  assert.ok(ids.indexOf('aging') < ids.indexOf('mlfq'));
  assert.deepEqual(item.course.pathConcepts.map((concept) => concept.id).sort(), [...ids].sort());

  // The learner skips a concept and moves one; a move before its prerequisite is refused.
  const skipped = plan.path.map((entry) => (entry.conceptId === 'aging' ? { ...entry, status: 'skipped' } : entry));
  item = (await h.call(CHANNELS.requirementsCoursePath, item.id, skipped)).data;
  assert.equal(item.course.plan.path.find((entry) => entry.conceptId === 'aging').status, 'skipped');
  const early = [...skipped].reverse();
  const refused = await h.call(CHANNELS.requirementsCoursePath, item.id, early);
  assert.equal(refused.error.code, 'invalid_argument');
  assert.match(refused.error.message, /comes before its prerequisite/);
  const dropped = await h.call(CHANNELS.requirementsCoursePath, item.id, skipped.slice(1));
  assert.match(dropped.error.message, /keep the planned concepts/);

  const published = await h.call(CHANNELS.requirementsPublish, item.id);
  assert.equal(published.data.status, 'published');
  // Nothing reaches the queue: the labs are published later.
  assert.equal((await h.call(CHANNELS.tasksList)).data.filter((task) => task.requirementId === item.id).length, 0);
});

test('course: 想学编译原理的词法分析 drafts a pack that validates, saved pending, confirmed, then planned from', async () => {
  const badDraft = { ...goals.LEXING_DRAFT, rubric: [goals.LEXING_DRAFT.rubric[0]] };
  const lexPath = {
    summary: '从记号到扫描器。',
    path: goals.LEXING_DRAFT.concepts.map((concept) => ({ conceptId: concept.id, status: 'planned' })),
    extraConcepts: [],
  };
  const h = await fixtures.harness({ agent: tutor({ interview: goals.LEXING_CLARIFY, draft: [badDraft, goals.LEXING_DRAFT], path: lexPath }) });
  let item = await createCourse(h, '想学编译原理的词法分析');
  assert.equal(item.course.pick.course, null);

  await h.call(CHANNELS.requirementsPlan, item.id, [], { draft: true });
  await h.idle();
  item = (await h.call(CHANNELS.requirementsGet, item.id)).data;
  assert.equal(item.status, 'reviewing');
  // The first draft was refused and its error fed back once.
  const drafts = h.agentCalls.filter((call) => interviewStep(call.schema) === 'draft');
  assert.equal(drafts.length, 2);
  assert.match(drafts[1].prompt, /<errors>\n- rubric: must be a list of 2 to 6 items/);
  const { pack, contentHash } = item.course.draft;
  assert.equal(pack.id, 'lexing');
  assert.equal(pack.version, '0.1.0');
  assert.match(contentHash, /^[0-9a-f]{64}$/);
  // A draft is never a file until the learner saves it.
  await assert.rejects(fs.access(path.join(h.configDir, 'courses/lexing.toml')));

  // The learner edits the title and saves: a user pack, pending on this machine.
  const { data: saved } = await h.call(CHANNELS.requirementsCourseSaveDraft, item.id, { ...pack, title: '词法分析入门' });
  assert.deepEqual(saved.requirement.course.choice, { course: 'lexing' });
  assert.equal(saved.requirement.course.draft, null);
  assert.equal(saved.ref.source, 'user');
  const list = (await h.call(CHANNELS.coursesList)).data;
  assert.equal(list.entries.find((entry) => entry.id === 'lexing').trust, 'pending');

  // Unconfirmed, it is not planned from.
  captureExpectedErrors((error) => 'code' in error && error.code === 'course_not_confirmed' && error.message.includes('lexing'));
  await h.call(CHANNELS.requirementsPlan, item.id);
  await h.idle();
  item = (await h.call(CHANNELS.requirementsGet, item.id)).data;
  assert.equal(item.status, 'failed');
  assert.equal(item.error.code, 'course_not_confirmed');

  // Confirmed at the content shown, it is.
  assert.equal((await h.call(CHANNELS.requirementsCourseConfirmDraft, item.id, 'f'.repeat(64))).error.code, 'course_changed');
  await h.call(CHANNELS.requirementsCourseConfirmDraft, item.id, saved.ref.contentHash);
  assert.equal((await h.call(CHANNELS.coursesList)).data.entries.find((entry) => entry.id === 'lexing').trust, 'confirmed');
  await h.call(CHANNELS.requirementsPlan, item.id);
  await h.idle();
  item = (await h.call(CHANNELS.requirementsGet, item.id)).data;
  assert.equal(item.status, 'reviewing');
  assert.equal(item.course.plan.course.id, 'lexing');
  assert.equal(item.course.plan.course.contentHash, saved.ref.contentHash);
});

test('course: a draft that fails twice fails the run, and a draft never replaces an existing pack id', async () => {
  const bad = { ...goals.LEXING_DRAFT, rubric: [goals.LEXING_DRAFT.rubric[0]] };
  const h = await fixtures.harness({ agent: tutor({ interview: goals.LEXING_CLARIFY, draft: [bad, bad, { ...goals.LEXING_DRAFT, id: 'os' }] }) });
  let item = await createCourse(h, '想学编译原理的词法分析');
  await h.call(CHANNELS.requirementsPlan, item.id, [], { draft: true });
  await h.idle();
  item = (await h.call(CHANNELS.requirementsGet, item.id)).data;
  assert.equal(item.status, 'failed');
  assert.equal(item.error.code, 'agent_bad_output');
  assert.match(item.error.message, /does not validate/);

  await h.call(CHANNELS.requirementsPlan, item.id);
  await h.idle();
  item = (await h.call(CHANNELS.requirementsGet, item.id)).data;
  assert.equal(item.course.draft.pack.id, 'os-2');
});

test('course: the form is checked, and the project flow is unchanged beside it', async () => {
  const h = await fixtures.harness({ agent: fixtures.fakeAgent() });
  const refused = await h.call(CHANNELS.requirementsCreate, { text: '想学', course: { ...goals.GOAL_FORM, weeklyHours: 100 } });
  assert.equal(refused.error.field, 'goal.weeklyHours');
  const { data } = await h.call(CHANNELS.requirementsCreate, { text: '用户可以用邮箱登录' });
  await h.idle();
  const item = (await h.call(CHANNELS.requirementsGet, data.id)).data;
  assert.equal(item.kind, undefined);
  assert.equal(item.course, undefined);
  assert.equal(item.questions[0].text, '连续失败几次锁定？');
  assert.equal((await h.call(CHANNELS.requirementsCoursePath, item.id, [])).error.code, 'invalid_state');
});
