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
  assert.match(prompt, /Weekly time: 4 hours/);
  assert.match(prompt, /<course id="os">/);
  assert.match(prompt, /- round-robin: /);
  assert.match(prompt, /At most 3 questions/);
  assert.match(interview.systemPrompt(), /never ask about those again/);
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
});

test('validatePath() refuses ids outside the skeleton, extras off the path and more than three extras', () => {
  const extra = { id: 'ai:sched-sim', label: '调度模拟器', summary: '用 C 写一个调度模拟器。', prerequisites: ['fcfs'] };
  const withExtra = {
    ...fixtures.SCHEDULING_PATH,
    path: [...fixtures.SCHEDULING_PATH.path, { conceptId: extra.id, status: 'planned' }],
    extraConcepts: [extra],
  };
  assert.equal(interview.validatePath(withExtra, OS_COURSE).extraConcepts[0].id, 'ai:sched-sim');
  assert.throws(() => interview.validatePath({ ...fixtures.SCHEDULING_PATH, extraConcepts: [extra] }, OS_COURSE), /not on the path/);
  assert.throws(
    () => interview.validatePath({ ...fixtures.SCHEDULING_PATH, path: [{ conceptId: 'lexing', status: 'planned' }] }, OS_COURSE),
    /"lexing", which is not a concept/,
  );
  assert.throws(() => interview.validatePath({ ...withExtra, extraConcepts: [{ ...extra, id: 'sched-sim' }] }, OS_COURSE), /"ai:"/);
  const four = ['a', 'b', 'c', 'd'].map((slug) => ({ ...extra, id: `ai:${slug}` }));
  assert.throws(() => interview.validatePath({ ...withExtra, extraConcepts: four }, OS_COURSE), /more than 3/);
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
