// Tutor's grading and difference explanation (src/main/agents/tutor_grade.ts).
import { test } from 'vitest';
import assert from 'node:assert/strict';

import * as tutorGrade from '../../../src/main/agents/tutor_grade.ts';
import type { CoursePack } from '../../../src/shared/course_pack.ts';
import { PROGRAMMING_COURSE } from '../../fixtures/builtin_courses.ts';

const LEVELS = { thinking: 3, writing: 2, style: 4 };
const OS_LEVELS = { concept: 3, mechanism: 3 };

test('validateGrade keeps comments, drops locations outside the submission, and refuses bad output', () => {
  const { validateGrade } = tutorGrade;
  const comment = { category: 'thinking', file: 'a.ts', line: 2, observation: '先写了实现再写测试。', betterWay: '先写一个会失败的测试。', repeated: false };
  const report = validateGrade(
    { summary: '不错', strengths: ['命名清楚'], comments: [comment, { ...comment, file: 'other.ts' }, { ...comment, line: 0 }], levels: LEVELS },
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
    assert.throws(
      () => validateGrade({ summary: 's', strengths: [], comments: [bad], levels: LEVELS }, { changedPaths: ['a.ts'], course: PROGRAMMING_COURSE }),
      {
        code: 'agent_bad_output',
      },
    );
  assert.throws(
    () =>
      validateGrade({ summary: 's', strengths: [], comments: Array(13).fill(comment), levels: LEVELS }, { changedPaths: ['a.ts'], course: PROGRAMMING_COURSE }),
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

test('grading with another course pack marks, offers and accepts only its rubric ids', () => {
  const { gradeSchema, gradeSystemPrompt, validateGrade } = tutorGrade;
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
  assert.equal(validateGrade({ summary: 's', strengths: [], comments: [comment], levels: OS_LEVELS }, options).comments[0].category, 'concept');
  for (const category of ['thinking', 'style', 42])
    assert.throws(() => validateGrade({ summary: 's', strengths: [], comments: [{ ...comment, category }], levels: OS_LEVELS }, options), {
      code: 'agent_bad_output',
      message: /comments\[0\]\.category.*concept, mechanism/,
    });
});

// errorTags feed mastery (src/main/courses/mastery_store.ts); a bad tag is dropped, never fails the grade.
test('validateGrade keeps up to three well-formed error tags and drops the rest', () => {
  const { gradeSchema, validateGrade, MAX_ERROR_TAGS } = tutorGrade;
  const schema = gradeSchema(PROGRAMMING_COURSE);
  assert.ok(schema.required.includes('errorTags'));
  assert.equal(schema.properties.errorTags.maxItems, MAX_ERROR_TAGS);
  const grade = (errorTags: unknown) =>
    validateGrade({ summary: 's', strengths: [], comments: [], errorTags, levels: LEVELS }, { changedPaths: [], course: PROGRAMMING_COURSE }).errorTags;
  assert.deepEqual(grade(['off-by-one', ' missing-error-path ', 'off-by-one']), ['off-by-one', 'missing-error-path']);
  assert.deepEqual(grade(['Off By One', '边界', 'a'.repeat(33), 3, 'x-1', 'y-2', 'z-3', 'w-4']), ['x-1', 'y-2', 'z-3']);
  assert.deepEqual(grade(undefined), [], 'a CLI that drops the field');
  assert.deepEqual(grade('off-by-one'), []);
});

// The levels feed the quality score (src/main/work_packages/grade_scores.ts): every rubric item needs one.
test('validateGrade needs a level 1 to 4 for every rubric item, and the schema asks for exactly those', () => {
  const { gradeSchema, validateGrade } = tutorGrade;
  const schema = gradeSchema(OS_COURSE);
  assert.ok(schema.required.includes('levels'));
  assert.deepEqual(schema.properties.levels.required, ['concept', 'mechanism']);
  assert.deepEqual(schema.properties.levels.properties.concept, { type: 'integer', minimum: 1, maximum: 4, description: 'Level for concept' });
  const grade = (levels: unknown) => validateGrade({ summary: 's', strengths: [], comments: [], levels }, { changedPaths: [], course: OS_COURSE });
  // Extra ids are dropped; only the pack's are kept.
  assert.deepEqual(grade({ concept: 1, mechanism: 4, thinking: 2 }).levels, { concept: 1, mechanism: 4 });
  for (const bad of [undefined, null, { concept: 3 }, { concept: 0, mechanism: 3 }, { concept: 5, mechanism: 3 }, { concept: 2.5, mechanism: 3 }])
    assert.throws(() => grade(bad), { code: 'agent_bad_output', message: /levels/ });
});

test('validateDifferences keeps up to three, drops files the reference does not change and code blocks', () => {
  const { differencesSchema, validateDifferences, MAX_DIFFERENCES } = tutorGrade;
  assert.equal(differencesSchema(OS_COURSE).properties.differences.maxItems, MAX_DIFFERENCES);
  assert.deepEqual(differencesSchema(OS_COURSE).properties.differences.items.properties.category.enum, ['concept', 'mechanism']);
  const options = { course: OS_COURSE, referencePaths: ['kernel/proc.c'] };
  const parsed = validateDifferences(
    {
      differences: [
        { category: 'concept', file: 'kernel/proc.c', difference: '参考实现在 `yield()` 前先拿锁。' },
        { category: 'mechanism', file: 'elsewhere.c', difference: '它这样写：```c\nacquire(&p->lock);\n```' },
      ],
    },
    options,
  );
  assert.deepEqual(parsed, [
    { category: 'concept', file: 'kernel/proc.c', difference: '参考实现在 `yield()` 前先拿锁。' },
    { category: 'mechanism', file: null, difference: '它这样写：`…`' },
  ]);
  assert.deepEqual(validateDifferences({ differences: [] }, options), []);
  const one = { category: 'concept', file: null, difference: 'd' };
  for (const bad of [{ differences: Array(4).fill(one) }, { differences: [{ ...one, category: 'style' }] }, { differences: [{ ...one, difference: ' ' }] }])
    assert.throws(() => validateDifferences(bad, options), { code: 'agent_bad_output' });
});

test('validateFeedback needs one reply per answer; a right answer has nothing missed', () => {
  const { feedbackSchema, validateFeedback } = tutorGrade;
  assert.deepEqual([feedbackSchema(2).properties.replies.minItems, feedbackSchema(2).properties.replies.maxItems], [2, 2]);
  assert.deepEqual(
    validateFeedback(
      {
        replies: [
          { correct: true, missed: 'ignored' },
          { correct: false, missed: '没提到锁。' },
        ],
      },
      2,
    ),
    [
      { correct: true, missed: null },
      { correct: false, missed: '没提到锁。' },
    ],
  );
  assert.deepEqual(validateFeedback({ replies: [{ correct: false, missed: null }] }, 1), [{ correct: false, missed: null }]);
  for (const bad of [{ replies: [] }, { replies: [{ correct: 'yes', missed: null }] }, { replies: [{ correct: true }, { correct: true }] }])
    assert.throws(() => validateFeedback(bad, 1), { code: 'agent_bad_output' });
});

test('the explanation prompts carry the package, the submission, the reference and the answers', () => {
  const task = { title: '时间片', intro: '加轮转。', steps: [], fileScope: [], acceptance: [] };
  const system = tutorGrade.differencesSystemPrompt(OS_COURSE);
  assert.ok(system.includes('concept (the model of the mechanism), mechanism (locking and error paths)'));
  assert.ok(system.includes('Do not say why'));
  const prompt = tutorGrade.differencesPrompt({ task, submission: [{ path: 'a.c', patch: '+x' }], reference: '+y' });
  assert.ok(prompt.includes('<submission>\n<file path="a.c">\n+x\n</file>\n</submission>'));
  assert.ok(prompt.includes('<reference_solution>\n+y\n</reference_solution>'));
  const feedback = tutorGrade.feedbackPrompt({ task, reference: '+y', answers: [{ difference: '先拿锁', answer: '防止竞争' }] });
  assert.ok(feedback.includes('<answer index="0">\nDifference: 先拿锁\nWhy, in the developer’s words: 防止竞争\n</answer>'));
  assert.match(tutorGrade.FEEDBACK_SYSTEM_PROMPT, /Reply once/);
});
