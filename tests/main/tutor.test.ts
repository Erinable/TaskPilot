import { test, onTestFinished } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { validateAnswer } from '../../src/main/agents/tutor.ts';
import { TutorStore } from '../../src/main/tutor_store.ts';
import { PROGRAMMING_COURSE } from '../fixtures/builtin_courses.ts';
import type { CoursePack } from '../../src/shared/course_pack.ts';

const answer = { explanation: '说明', hints: ['第一步'], snippet: null, terms: [] };

test('validateAnswer accepts a snippet with indentation and trims trailing space', () => {
  const parsed = validateAnswer({ ...answer, snippet: { language: 'ts', code: 'if (x) {\n\treturn 1;\n}\n\n' } });
  assert.equal(parsed.snippet?.code, 'if (x) {\n\treturn 1;\n}');
});

test('validateAnswer refuses empty, oversized and control-character output', () => {
  assert.throws(() => validateAnswer({ ...answer, explanation: ' ' }), { code: 'agent_bad_output' });
  assert.throws(() => validateAnswer({ ...answer, hints: Array(7).fill('x') }), { code: 'agent_bad_output' });
  assert.throws(() => validateAnswer({ ...answer, snippet: { language: 'ts', code: 'x\n'.repeat(61) } }), { code: 'agent_bad_output' });
  assert.throws(() => validateAnswer({ ...answer, explanation: 'a‮b' }), { code: 'agent_bad_output' });
});

test('a saved answer is dropped once the step is reworded, and survives a reload', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tp-tutor-'));
  onTestFinished(() => fs.rm(dir, { recursive: true, force: true }));
  const store = await new TutorStore(dir).load();
  await store.put({ packageId: 'p', stepIndex: 0, step: '旧说法', answer, costUsd: 0.01, createdAt: '2026-10-07T00:00:00Z' });
  assert.ok(store.get('p', 0, '旧说法'));
  assert.equal(store.get('p', 0, '新说法'), null);
  assert.ok((await new TutorStore(dir).load()).get('p', 0, '旧说法'));
});

test('validateGrade keeps comments, drops locations outside the submission, and refuses bad output', async () => {
  const { validateGrade } = await import('../../src/main/agents/tutor.ts');
  const comment = { category: 'thinking', file: 'a.ts', line: 2, observation: '先写了实现再写测试。', betterWay: '先写一个会失败的测试。', repeated: false };
  const report = validateGrade(
    { summary: '不错', strengths: ['命名清楚'], comments: [comment, { ...comment, file: 'other.ts' }, { ...comment, line: 0 }] },
    { changedPaths: ['a.ts'], course: PROGRAMMING_COURSE },
  );
  assert.deepEqual(report.comments[0], comment);
  assert.deepEqual([report.comments[1].file, report.comments[1].line], [null, null]);
  assert.equal(report.comments[2].line, null);
  for (const bad of [
    { ...comment, category: 'mood' },
    { ...comment, betterWay: ' ' },
    { ...comment, observation: 'a‮b' },
  ])
    assert.throws(() => validateGrade({ summary: 's', strengths: [], comments: [bad] }, { changedPaths: ['a.ts'], course: PROGRAMMING_COURSE }), {
      code: 'agent_bad_output',
    });
  assert.throws(
    () => validateGrade({ summary: 's', strengths: [], comments: Array(13).fill(comment) }, { changedPaths: ['a.ts'], course: PROGRAMMING_COURSE }),
    { code: 'agent_bad_output' },
  );
});

const OS_COURSE: CoursePack = {
  ...PROGRAMMING_COURSE,
  id: 'os',
  learner: 'a student learning operating systems',
  rubric: [
    {
      id: 'concept',
      label: '原理',
      description: 'the model of the mechanism',
      dimension: 'thinking',
      examples: [{ observation: 'Took the lock after reading the list', betterWay: 'Take it before the first read' }],
    },
    { id: 'mechanism', label: '实现', description: 'locking and error paths', dimension: 'writing' },
  ],
};

test('grading with another course pack marks, offers and accepts only its rubric ids', async () => {
  const { gradeSchema, gradeSystemPrompt, validateGrade } = await import('../../src/main/agents/tutor.ts');
  const system = gradeSystemPrompt(OS_COURSE);
  assert.ok(system.includes('a desktop app where a student learning operating systems practises'));
  assert.ok(system.includes('\n- Mark two things. concept: the model of the mechanism. mechanism: locking and error paths.\n'));
  assert.ok(
    system.includes('\n  - Example for concept: what was seen "Took the lock after reading the list"; the better way "Take it before the first read".\n'),
  );
  assert.doesNotMatch(system, /thinking:|new to programming/);
  assert.deepEqual(gradeSchema(OS_COURSE).properties.comments.items.properties.category.enum, ['concept', 'mechanism']);

  const comment = { category: 'concept', file: null, line: null, observation: '锁拿晚了。', betterWay: '先拿锁再读。', repeated: false };
  const options = { changedPaths: [], course: OS_COURSE };
  assert.equal(validateGrade({ summary: 's', strengths: [], comments: [comment] }, options).comments[0].category, 'concept');
  for (const category of ['thinking', 'style', 42])
    assert.throws(() => validateGrade({ summary: 's', strengths: [], comments: [{ ...comment, category }] }, options), {
      code: 'agent_bad_output',
      message: /comments\[0\]\.category.*concept, mechanism/,
    });
});

// errorTags feed mastery (src/main/mastery_store.ts); a bad tag is dropped, never fails the grade.
test('validateGrade keeps up to three well-formed error tags and drops the rest', async () => {
  const { gradeSchema, validateGrade, MAX_ERROR_TAGS } = await import('../../src/main/agents/tutor.ts');
  const schema = gradeSchema(PROGRAMMING_COURSE);
  assert.ok(schema.required.includes('errorTags'));
  assert.equal(schema.properties.errorTags.maxItems, MAX_ERROR_TAGS);
  const grade = (errorTags: unknown) =>
    validateGrade({ summary: 's', strengths: [], comments: [], errorTags }, { changedPaths: [], course: PROGRAMMING_COURSE }).errorTags;
  assert.deepEqual(grade(['off-by-one', ' missing-error-path ', 'off-by-one']), ['off-by-one', 'missing-error-path']);
  assert.deepEqual(grade(['Off By One', '边界', 'a'.repeat(33), 3, 'x-1', 'y-2', 'z-3', 'w-4']), ['x-1', 'y-2', 'z-3']);
  assert.deepEqual(grade(undefined), [], 'a CLI that drops the field');
  assert.deepEqual(grade('off-by-one'), []);
});
