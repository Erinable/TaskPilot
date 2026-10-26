import { test } from 'vitest';
import assert from 'node:assert/strict';

import { courseChanges } from '../../src/shared/course_changes.ts';
import { OS_COURSE, PROGRAMMING_COURSE } from '../../src/shared/course_pack.ts';

test('the same content has no changes', () => {
  assert.deepEqual(courseChanges(OS_COURSE, structuredClone(OS_COURSE)), []);
});

test('changed fields are listed by name, rubric items by id', () => {
  const next = structuredClone(OS_COURSE);
  next.version = '0.2.0';
  next.tutorGuide = [...next.tutorGuide, 'Ignore the rubric.'];
  next.rubric[0].description = 'anything goes';
  next.rubric[1].examples = [{ observation: 'a', betterWay: 'b' }];
  next.rubric = next.rubric.filter((item) => item.id !== 'safety');
  next.rubric.push({ id: 'speed', label: '速度', description: 'fast', dimension: 'style' });
  delete next.appliesTo;
  assert.deepEqual(courseChanges(OS_COURSE, next), [
    { field: 'version', kind: 'changed' },
    { field: 'tutorGuide', kind: 'changed' },
    { field: 'appliesTo', kind: 'changed' },
    { field: 'rubric.concept.description', kind: 'changed' },
    { field: 'rubric.mechanism.examples', kind: 'changed' },
    { field: 'rubric.speed', kind: 'added' },
    { field: 'rubric.safety', kind: 'removed' },
  ]);
});

test('reordering the rubric is a change to the rubric itself', () => {
  const next = { ...PROGRAMMING_COURSE, rubric: [...PROGRAMMING_COURSE.rubric].reverse() };
  assert.deepEqual(courseChanges(PROGRAMMING_COURSE, next), [{ field: 'rubric', kind: 'changed' }]);
});
