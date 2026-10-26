import { expect, test } from 'vitest';

import { checkCourse } from '@shared/course_rules.ts';
import { BUILTIN_COURSES, OS_COURSE } from '../fixtures/builtin_courses.ts';

test('the built-in packs pass, unchanged', () => {
  for (const pack of BUILTIN_COURSES) expect(checkCourse(structuredClone(pack))).toEqual({ pack, errors: [] });
});

test('every error is listed, each on its field, so the editor can show them all at once', () => {
  const { pack, errors } = checkCourse({
    ...OS_COURSE,
    title: ' ',
    version: 'v1',
    tutorGuide: ['ok', 'x'.repeat(301)],
    rubric: [
      { ...OS_COURSE.rubric[0], dimension: 'safety' },
      { ...OS_COURSE.rubric[1], id: OS_COURSE.rubric[0].id },
    ],
  });
  expect(pack).toBeNull();
  expect(errors.map((error) => [error.field, error.kind])).toEqual([
    ['version', 'version'],
    ['title', 'empty'],
    ['tutorGuide[1]', 'too_long'],
    ['rubric[0].dimension', 'dimension'],
  ]);
  expect(errors[2].max).toBe(300);
});

test('a repeated rubric id is found once the items themselves are valid', () => {
  const { errors } = checkCourse({ ...OS_COURSE, rubric: [OS_COURSE.rubric[0], { ...OS_COURSE.rubric[1], id: OS_COURSE.rubric[0].id }] });
  expect(errors).toEqual([{ field: 'rubric[1].id', kind: 'repeat', message: `rubric[1].id: repeats "${OS_COURSE.rubric[0].id}"` }]);
});
