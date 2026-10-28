// Pure lab planning: choose the next concept and difficulty from the
// confirmed course path and mastery records.
import { failWith } from '../infrastructure/coded_error.ts';
import * as progress from './lab_progress.ts';
import type { Requirement } from '../requirements/requirement_store.ts';
import type { MasteryRecord } from './mastery_store.ts';
import { DEFAULT_COURSE_ID } from '../../shared/course_pack.ts';
import type { Concept } from '../../shared/course_pack.ts';
import type * as requirementTypes from '../../shared/ipc/requirements.ts';
import type { NextConcept } from './lab_progress.ts';
import type { Difficulty } from '../../shared/ipc/packages.ts';
import type { NoteMeta } from '../../shared/ipc/notes.ts';

// The concept and difficulty of the next lab: the one ./lab_progress.ts
export type NextLab = NextConcept & { concept: Concept };
const FIRST_DIFFICULTY: Record<requirementTypes.CourseInterview['form']['level'], Difficulty> = { new: 'easy', basic: 'easy', solid: 'medium' };
// picked instead (a self-check that ended in needs_review offers another),
// which must be on the path and still to learn.
export const nextLab = (item: Requirement, records: Map<string, MasteryRecord>, conceptId: string | null = null): NextLab => {
  const plan = item.course?.plan ?? failWith('There is no confirmed path', 'invalid_state');
  const concepts = [...item.course!.pathConcepts, ...plan.extraConcepts];
  const start = FIRST_DIFFICULTY[item.course!.form.level];
  const next = progress.nextConcept({ path: plan.path, concepts, records, start, only: conceptId });
  if (!next && conceptId) return failWith(`${conceptId} is not a concept still to learn on the path`, 'invalid_argument', 'conceptId');
  if (!next) {
    if (plan.path.some((candidate) => candidate.status === 'planned' && !progress.isMastered(records.get(candidate.conceptId) ?? null)))
      return failWith('Every concept left waits on a prerequisite that has not passed', 'nothing_to_learn');
    return failWith('Every concept on the path is known, skipped or mastered', 'nothing_to_learn');
  }
  const concept = concepts.find((candidate) => candidate.id === next.conceptId);
  return { ...next, concept: concept ?? failWith(`The path names an unknown concept ${next.conceptId}`, 'invalid_state') };
};

// Notes offered for review when the learner is stuck on a concept.
// [人工决策-2026-10-27 00:36:21] 不能卡住：同一知识点连续 2 次 fail 自动降一级；降到 easy 还 fail，
// 提示学生先复习这个知识点的笔记，或把它标成跳过（requirements:course-skip）。
export const stuckNotes = (notes: NoteMeta[], course: string, conceptId: string, limit = 10) =>
  notes
    .filter((note) => note.concepts.includes(conceptId) && (note.course ?? DEFAULT_COURSE_ID) === course)
    .slice(0, limit)
    .map((note) => ({ id: note.id, title: note.title }));
