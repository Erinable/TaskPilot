// What changed in a course pack since this machine confirmed it, field by
// field, so a re-confirmation shows the changes instead of asking the same
// question again. Rubric items and concepts are compared by id.
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
  'labGuide',
] as const;
const RUBRIC_FIELDS = ['label', 'description', 'dimension', 'examples'] as const;
const CONCEPT_FIELDS = ['label', 'summary', 'prerequisites', 'dimension'] as const;

const same = (left: unknown, right: unknown) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

// `<list>.<id>` for an added or removed item, `<list>.<id>.<field>` for a
// changed one, and `<list>` when only the order moved.
const itemChanges = <T extends { id: string }>(list: string, previous: T[], next: T[], fields: readonly (keyof T & string)[]): CourseChange[] => {
  const changes: CourseChange[] = [];
  const before = new Map(previous.map((item) => [item.id, item]));
  const after = new Set(next.map((item) => item.id));
  for (const item of next) {
    const old = before.get(item.id);
    if (!old) changes.push({ field: `${list}.${item.id}`, kind: 'added' });
    else for (const key of fields) if (!same(old[key], item[key])) changes.push({ field: `${list}.${item.id}.${key}`, kind: 'changed' });
  }
  for (const item of previous) if (!after.has(item.id)) changes.push({ field: `${list}.${item.id}`, kind: 'removed' });
  const kept = (items: T[]) => items.map((item) => item.id).filter((id) => before.has(id) && after.has(id));
  if (!same(kept(previous), kept(next))) changes.push({ field: list, kind: 'changed' });
  return changes;
};

export const courseChanges = (previous: CoursePack, next: CoursePack): CourseChange[] => [
  ...COURSE_TEXT_FIELDS.filter((field) => !same(previous[field], next[field])).map((field): CourseChange => ({ field, kind: 'changed' })),
  ...itemChanges('rubric', previous.rubric, next.rubric, RUBRIC_FIELDS),
  ...itemChanges('concepts', previous.concepts ?? [], next.concepts ?? [], CONCEPT_FIELDS),
];
