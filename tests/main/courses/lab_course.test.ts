import { test } from 'vitest';
import assert from 'node:assert/strict';

import { checkLabCourse } from '../../../src/main/courses/lab_course.ts';
import { BUILTIN } from '../../fixtures/builtin_courses.ts';

const course = BUILTIN.get('os')!;

test('lab course snapshot validation retains schema, version and content hash boundaries', () => {
  assert.deepEqual(checkLabCourse(course.pack, course.ref), course);
  assert.throws(() => checkLabCourse({ ...course.pack, schemaVersion: 2 } as unknown as typeof course.pack, course.ref), { code: 'invalid_course' });
  assert.throws(() => checkLabCourse(course.pack, { ...course.ref, version: '99.0.0' }), { code: 'course_changed' });
  assert.throws(() => checkLabCourse({ ...course.pack, tutorGuide: ['未确认的指导'] }, course.ref), { code: 'course_changed' });
});
