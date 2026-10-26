// What changed in a course pack since this machine confirmed it, field by
// field, so a re-confirmation shows the changes instead of asking the same
// question again. Rubric items are compared by id.
//
// [人工决策-2026-10-26 15:38:21] 信任确认前展示整包内容；contentHash 变化时列出改动的字段，避免用户习惯性点"确认"。
import type { CoursePack } from './course_pack.ts';

export type CourseChange = { field: string; kind: 'added' | 'removed' | 'changed' };

// The fields compared as a whole; id and schemaVersion never differ between two contents of one pack.
const COURSE_TEXT_FIELDS = [
  'version',
  'domain',
  'title',
  'summary',
  'learner',
  'tutorGuide',
  'difficultyGuide',
  'practiceGuide',
  'referenceGuide',
  'appliesTo',
] as const;
const RUBRIC_FIELDS = ['label', 'description', 'dimension', 'examples'] as const;

const same = (left: unknown, right: unknown) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

// `rubric.<id>` for an added or removed item, `rubric.<id>.<field>` for a
// changed one, and `rubric` when only the order moved.
export const courseChanges = (previous: CoursePack, next: CoursePack): CourseChange[] => {
  const changes: CourseChange[] = COURSE_TEXT_FIELDS.filter((field) => !same(previous[field], next[field])).map((field) => ({ field, kind: 'changed' }));
  const before = new Map(previous.rubric.map((item) => [item.id, item]));
  const after = new Set(next.rubric.map((item) => item.id));
  for (const item of next.rubric) {
    const old = before.get(item.id);
    if (!old) changes.push({ field: `rubric.${item.id}`, kind: 'added' });
    else for (const key of RUBRIC_FIELDS) if (!same(old[key], item[key])) changes.push({ field: `rubric.${item.id}.${key}`, kind: 'changed' });
  }
  for (const item of previous.rubric) if (!after.has(item.id)) changes.push({ field: `rubric.${item.id}`, kind: 'removed' });
  const kept = (pack: CoursePack) => pack.rubric.map((item) => item.id).filter((id) => before.has(id) && after.has(id));
  if (!same(kept(previous), kept(next))) changes.push({ field: 'rubric', kind: 'changed' });
  return changes;
};
