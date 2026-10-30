import { test } from 'vitest';
import assert from 'node:assert/strict';

import * as interview from '../../../src/main/agents/course_interview.ts';
import { checkCourse } from '../../../src/shared/course_rules.ts';
import { OS_COURSE } from '../../fixtures/builtin_courses.ts';
import * as fixtures from '../../fixtures/course_interview.ts';

const GOAL = { goal: '想学操作系统的进程调度', form: fixtures.GOAL_FORM };

test('the interview prompt carries the form, the offered packs and their concept ids, never asks the form again', () => {
  const prompt = interview.clarifyPrompt({ ...GOAL, courses: [{ ...OS_COURSE, concepts: OS_COURSE.concepts! }] });
  assert.match(prompt, /<goal>\n想学操作系统的进程调度\n<\/goal>/);
  assert.match(prompt, /Level: knows the basics/);
  assert.match(prompt, /Toolchain: c/);
  assert.match(prompt, /Weekly time: 4 hours/);
  assert.match(prompt, /<course id="os">/);
  assert.match(prompt, /- round-robin: /);
  assert.match(prompt, /At most 3 questions/);
  assert.match(interview.systemPrompt(), /never ask about those again/);
});

test('interview prompts omit an empty environment note', () => {
  const prompt = interview.clarifyPrompt({ ...GOAL, form: { ...fixtures.GOAL_FORM, environment: '' }, courses: [] });
  assert.match(prompt, /Toolchain: c/);
  assert.doesNotMatch(prompt, /Environment:/);
});

test('validateClarify() accepts an offered pack or null and at most three questions', () => {
  const ids = ['programming', 'os'];
  assert.equal(interview.validateClarify(fixtures.SCHEDULING_CLARIFY, ids).course, 'os');
  assert.equal(interview.validateClarify(fixtures.LEXING_CLARIFY, ids).course, null);
  assert.throws(() => interview.validateClarify({ ...fixtures.SCHEDULING_CLARIFY, course: 'compilers' }, ids), /course must be null or one of/);
  assert.throws(() => interview.validateClarify({ ...fixtures.SCHEDULING_CLARIFY, questions: ['a', 'b', 'c', 'd'] }, ids), /more than 3/);
  assert.deepEqual(interview.clarifySchema(ids).properties.course.anyOf[1], { type: 'string', enum: ids });
});

test('validatePath() puts the os scheduling path in prerequisite order', () => {
  const planned = interview.validatePath(fixtures.SCHEDULING_PATH, OS_COURSE);
  const ids = planned.path.map((entry) => entry.conceptId);
  assert.ok(ids.indexOf('trap-syscall') < ids.indexOf('context-switch'));
  assert.ok(ids.indexOf('timer-interrupt') < ids.indexOf('round-robin'));
  assert.ok(ids.indexOf('aging') < ids.indexOf('mlfq'));
  assert.ok(!ids.includes('multicore-sched'));
  assert.equal(planned.path.find((entry) => entry.conceptId === 'process-state')?.status, 'known');
  const extra = { id: 'ai:sched-sim', label: '调度模拟器', summary: '用 C 写一个调度模拟器。', prerequisites: ['fcfs'] };
  assert.equal(
    interview.validatePath(
      { ...fixtures.SCHEDULING_PATH, path: [...fixtures.SCHEDULING_PATH.path, { conceptId: extra.id, status: 'planned' }], extraConcepts: [extra] },
      OS_COURSE,
    ).extraConcepts[0].id,
    extra.id,
  );
});

test.each([
  [
    'extra not on path',
    { extraConcepts: [{ id: 'ai:sched-sim', label: '调度模拟器', summary: '用 C 写一个调度模拟器。', prerequisites: ['fcfs'] }] },
    /not on the path/,
  ],
  ['unknown skeleton concept', { path: [{ conceptId: 'lexing', status: 'planned' }] }, /"lexing", which is not a concept/],
  ['non-ai extra id', { extraConcepts: [{ id: 'sched-sim', label: '调度模拟器', summary: 'x', prerequisites: [] }] }, /"ai:"/],
  ['too many extras', { extraConcepts: ['a', 'b', 'c', 'd'].map((id) => ({ id: `ai:${id}`, label: id, summary: 'x', prerequisites: [] })) }, /more than 3/],
])('validatePath rejects %s', (_name, override, expected) => {
  assert.throws(() => interview.validatePath({ ...fixtures.SCHEDULING_PATH, ...override }, OS_COURSE), expected);
});

test('a draft gets TaskPilot’s schema version and first version and validates as a course pack', () => {
  const pack = interview.draftPack({ ...fixtures.LEXING_DRAFT, version: '9.9.9', schemaVersion: 7 });
  const { pack: checked, errors } = checkCourse(pack);
  assert.deepEqual(errors, []);
  assert.equal(checked?.version, interview.DRAFT_VERSION);
  assert.equal(checked?.schemaVersion, 1);
});

test('the retry prompt feeds the refused draft’s errors back', () => {
  const errors = checkCourse(interview.draftPack({ ...fixtures.LEXING_DRAFT, rubric: [fixtures.LEXING_DRAFT.rubric[0]] })).errors;
  const prompt = interview.draftPrompt({ ...GOAL, goal: '想学编译原理的词法分析', errors });
  assert.match(prompt, /<errors>\n- rubric: must be a list of 2 to 6 items\n<\/errors>/);
  assert.doesNotMatch(interview.draftPrompt({ ...GOAL, goal: '想学编译原理的词法分析' }), /<errors>/);
});
