import { expect, test } from 'vitest';

import { changeText, changedFields, languageMismatch, sourcePath } from '@/lib/course_model.ts';

test('changes read as plain lines', () => {
  expect(changeText({ field: 'tutorGuide', kind: 'changed' })).toBe('修改 讲解指引');
  expect(changeText({ field: 'rubric.safety', kind: 'removed' })).toBe('删除 判卷维度 safety');
  expect(changeText({ field: 'rubric.concept.description', kind: 'changed' })).toBe('修改 判卷维度 concept 的说明');
  expect(changeText({ field: 'rubric', kind: 'changed' })).toBe('修改 判卷维度的顺序');
});

test('removed fields are listed but not marked, since they are not shown', () => {
  expect([
    ...changedFields([
      { field: 'rubric.a', kind: 'removed' },
      { field: 'title', kind: 'changed' },
    ]),
  ]).toEqual(['title']);
});

test("a pack warns only when it names languages and none is the repository's", () => {
  expect(languageMismatch(['c', 'rust'], ['typescript'])).toEqual(['c', 'rust']);
  expect(languageMismatch(['c', 'rust'], ['rust'])).toBeNull();
  expect(languageMismatch(null, ['typescript'])).toBeNull();
  expect(languageMismatch(['c'], [])).toBeNull();
});

test('a pack file is named where it lives', () => {
  expect(sourcePath('oslab', 'repository', '/u/courses')).toBe('.taskpilot/courses/oslab.toml');
  expect(sourcePath('net', 'user', '/u/courses')).toBe('/u/courses/net.toml');
  expect(sourcePath('os', 'builtin', '/u/courses')).toBeNull();
});

test('concept and labGuide changes read in words', () => {
  expect(changeText({ field: 'labGuide', kind: 'changed' })).toBe('修改 lab 生成指引');
  expect(changeText({ field: 'concepts.round-robin', kind: 'added' })).toBe('新增 知识点 round-robin');
  expect(changeText({ field: 'concepts.round-robin.prerequisites', kind: 'changed' })).toBe('修改 知识点 round-robin 的前置知识点');
  expect(changeText({ field: 'concepts.fcfs.label', kind: 'changed' })).toBe('修改 知识点 fcfs 的名称');
  expect(changeText({ field: 'concepts', kind: 'changed' })).toBe('修改 知识点的顺序');
});
