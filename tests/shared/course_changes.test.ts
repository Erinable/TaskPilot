import { test } from 'vitest';
import assert from 'node:assert/strict';

import { courseChanges } from '../../src/shared/course_changes.ts';
import { OS_COURSE, PROGRAMMING_COURSE } from '../fixtures/builtin_courses.ts';

test('the same content has no changes', () => {
  assert.deepEqual(courseChanges(OS_COURSE, structuredClone(OS_COURSE)), []);
});

test('changed fields are listed by name, rubric items by id', () => {
  const next = structuredClone(OS_COURSE);
  next.version = '0.3.0';
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

test('labGuide and concepts are compared like the other fields, concepts by id', () => {
  const next = structuredClone(OS_COURSE);
  next.labGuide = ['Only xv6.'];
  const [first, second, ...rest] = next.concepts!;
  next.concepts = [{ ...second, summary: 'changed' }, first, ...rest.slice(1), { id: 'new-node', label: '新', summary: 's', prerequisites: [] }];
  delete next.concepts[0].dimension;
  assert.deepEqual(courseChanges(OS_COURSE, next), [
    { field: 'labGuide', kind: 'changed' },
    { field: `concepts.${second.id}.summary`, kind: 'changed' },
    { field: `concepts.${second.id}.dimension`, kind: 'changed' },
    { field: 'concepts.new-node', kind: 'added' },
    { field: `concepts.${rest[0].id}`, kind: 'removed' },
    { field: 'concepts', kind: 'changed' },
  ]);
  // A pack that had none gains them all.
  const { concepts, ...bare } = OS_COURSE;
  assert.deepEqual(
    courseChanges(bare, OS_COURSE).filter((change) => change.field.startsWith('concepts')),
    concepts!.map((item) => ({ field: `concepts.${item.id}`, kind: 'added' })),
  );
});
