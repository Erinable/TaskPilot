import { expect, test } from 'vitest';

import * as courseModel from '@/lib/course_model.ts';
import { BUILTIN_COURSES } from '../../fixtures/builtin_courses.ts';

test('changes read as plain lines', () => {
  expect(courseModel.changeText({ field: 'tutorGuide', kind: 'changed' })).toBe('修改 讲解指引');
  expect(courseModel.changeText({ field: 'rubric.safety', kind: 'removed' })).toBe('删除 判卷维度 safety');
  expect(courseModel.changeText({ field: 'rubric.concept.description', kind: 'changed' })).toBe('修改 判卷维度 concept 的说明');
  expect(courseModel.changeText({ field: 'rubric', kind: 'changed' })).toBe('修改 判卷维度的顺序');
});

test('removed fields are listed but not marked, since they are not shown', () => {
  expect([
    ...courseModel.changedFields([
      { field: 'rubric.a', kind: 'removed' },
      { field: 'title', kind: 'changed' },
    ]),
  ]).toEqual(['title']);
});

test("a pack warns only when it names languages and none is the repository's", () => {
  expect(courseModel.languageMismatch(['c', 'rust'], ['typescript'])).toEqual(['c', 'rust']);
  expect(courseModel.languageMismatch(['c', 'rust'], ['rust'])).toBeNull();
  expect(courseModel.languageMismatch(null, ['typescript'])).toBeNull();
  expect(courseModel.languageMismatch(['c'], [])).toBeNull();
});

test('a pack file is named where it lives', () => {
  expect(courseModel.sourcePath('oslab', 'repository', '/u/courses')).toBe('.taskpilot/courses/oslab.toml');
  expect(courseModel.sourcePath('net', 'user', '/u/courses')).toBe('/u/courses/net.toml');
  expect(courseModel.sourcePath('os', 'builtin', '/u/courses')).toBeNull();
});

test('a draft turns back into the same pack', () => {
  for (const pack of BUILTIN_COURSES) expect(courseModel.packOf(courseModel.draftOf(pack))).toEqual(pack);
});

test('a copy gets <id>-copy by default, numbered when taken', () => {
  expect(courseModel.copyIdFor('os', ['programming'])).toBe('os-copy');
  expect(courseModel.copyIdFor('os', ['os-copy', 'os-copy2'])).toBe('os-copy3');
  expect(courseModel.copyIdFor('a'.repeat(32), []).length).toBeLessThanOrEqual(32);
});

test('field errors are worded for the editor', () => {
  expect(courseModel.fieldErrorText({ field: 'rubric', kind: 'list', message: '', min: 2, max: 6 })).toBe('要有 2 到 6 项。');
  expect(courseModel.fieldErrorText({ field: 'title', kind: 'too_long', message: '', max: 500 })).toBe('最多 500 个字。');
});

test('concept and labGuide changes read in words', () => {
  expect(courseModel.changeText({ field: 'labGuide', kind: 'changed' })).toBe('修改 lab 生成指引');
  expect(courseModel.changeText({ field: 'concepts.round-robin', kind: 'added' })).toBe('新增 知识点 round-robin');
  expect(courseModel.changeText({ field: 'concepts.round-robin.prerequisites', kind: 'changed' })).toBe('修改 知识点 round-robin 的前置知识点');
  expect(courseModel.changeText({ field: 'concepts.fcfs.label', kind: 'changed' })).toBe('修改 知识点 fcfs 的名称');
  expect(courseModel.changeText({ field: 'concepts', kind: 'changed' })).toBe('修改 知识点的顺序');
});
