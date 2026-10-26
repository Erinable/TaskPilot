// Which course pack a note's category belongs to, and what it means there:
// the rubric item's label and the shared dimension (thinking / writing /
// style) it maps onto. Read by the notes page and by grading.
//
// [人工决策-2026-10-26 15:38:21] 没有 course 的笔记视为 programming；跨领域按 thinking / writing / style 三个通用维度统计。
// 不认识的包或 rubric 项显示原 id，维度只有在 id 本身就是通用维度名时才算得出。
import { COURSE_DIMENSIONS, PROGRAMMING_COURSE } from './course_pack.ts';
import type { CourseDimension, RubricItem } from './course_pack.ts';

type Pack = { id: string; rubric: Pick<RubricItem, 'id' | 'label' | 'dimension'>[] };
type Categorized = { category: string | null; course: string | null };

export const noteCourseId = (note: Pick<Categorized, 'course'>) => note.course ?? PROGRAMMING_COURSE.id;

export const rubricItemOf = (note: Categorized, packs: Pack[]) =>
  note.category === null ? null : (packs.find((pack) => pack.id === noteCourseId(note))?.rubric.find((item) => item.id === note.category) ?? null);

export const isDimension = (value: unknown): value is CourseDimension => COURSE_DIMENSIONS.includes(value as CourseDimension);

export const dimensionOf = (note: Categorized, packs: Pack[]): CourseDimension | null =>
  rubricItemOf(note, packs)?.dimension ?? (isDimension(note.category) ? note.category : null);
