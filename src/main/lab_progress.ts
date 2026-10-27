// Course mode's progress rules, pure: when a concept counts as mastered,
// which concept on the learner's path the next lab covers and how hard it
// is, when the learner is stuck, and the Leitner review schedule of notes
// that carry concepts. Mastery records come from ./mastery_store.ts.
//
// [人工决策-2026-10-27 00:36:21] 掌握度一期用简单记录加笔记的间隔复习（Leitner 1 / 3 / 7 / 14 / 30 天），不做 BKT。
import { businessDay } from './activity_log.ts';
import type { Concept } from '../shared/course_pack.ts';
import type { NoteMeta } from '../shared/ipc/notes.ts';
import type { ConceptMastery, ConceptState, CourseMastery, ReviewSchedule } from '../shared/ipc/mastery.ts';
import type { PathEntry } from '../shared/course_plan.ts';
import type { Difficulty } from '../shared/ipc/packages.ts';
import type { MasteryAttempt, MasteryRecord } from './mastery_store.ts';

// ========== Mastery ==========

export const MASTERY_STREAK = 2;
export const MASTERY_INDEPENDENCE = 70;

// Mastered: the last two attempts both passed with independence of at least
// 70. Independence is null until grades carry it (T10); a null one is not
// measured and does not hold mastery back.
export const isMastered = (record: Pick<MasteryRecord, 'attempts'> | null): boolean => {
  const recent = record?.attempts.slice(-MASTERY_STREAK) ?? [];
  return (
    recent.length === MASTERY_STREAK &&
    recent.every((attempt) => attempt.result === 'pass' && (attempt.independence === null || attempt.independence >= MASTERY_INDEPENDENCE))
  );
};

// How a concept stands, for the mastery page.
export const conceptState = (record: MasteryRecord | null): ConceptState => {
  if (!record?.totals.attempts) return 'new';
  if (isMastered(record)) return 'mastered';
  return record.totals.pass > 0 ? 'passed' : 'learning';
};

// Error types shown on the mastery page.
export const TOP_ERROR_TYPES = 5;

// One course's skeleton with each concept's standing and its attempts, and
// the most frequent error types summed over the course's records.
export const courseMastery = (
  course: { id: string; title: string; concepts: Concept[] },
  records: Map<string, MasteryRecord>,
): Omit<CourseMastery, 'repositories'> => {
  const concepts = course.concepts.map((concept): ConceptMastery => {
    const record = records.get(concept.id) ?? null;
    return {
      id: concept.id,
      label: concept.label,
      summary: concept.summary,
      prerequisites: concept.prerequisites,
      state: conceptState(record),
      totals: record?.totals ?? { attempts: 0, pass: 0, partial: 0, fail: 0 },
      attempts: (record?.attempts ?? [])
        .toReversed()
        .map(({ at, packageId, repoId, result, independence }) => ({ at, packageId, repoId, result, independence })),
    };
  });
  const counts = new Map<string, number>();
  for (const record of records.values()) for (const entry of record.errorCounts) counts.set(entry.type, (counts.get(entry.type) ?? 0) + entry.count);
  const errorTypes = [...counts]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type))
    .slice(0, TOP_ERROR_TYPES);
  return { course: { id: course.id, title: course.title }, concepts, errorTypes };
};

// ========== Difficulty ==========

export const DIFFICULTIES: Difficulty[] = ['easy', 'medium', 'hard'];
// The highest hint level a pass may have used and still raise the difficulty.
export const RAISE_MAX_HINT_LEVEL = 2;

export type DifficultyChange = 'lowered' | 'raised' | 'kept';

const step = (level: Difficulty, offset: number): Difficulty =>
  DIFFICULTIES[Math.min(DIFFICULTIES.length - 1, Math.max(0, DIFFICULTIES.indexOf(level) + offset))];

const failedTwice = (attempts: MasteryAttempt[]) => attempts.length >= 2 && attempts.slice(-2).every((attempt) => attempt.result === 'fail');

// The difficulty after `attempts` (one concept's, newest last), starting
// from the last attempt's own difficulty, or `start` when it has none: the
// last two failed, one lower; the last passed with hints up to L2 at most,
// one higher; otherwise the same.
export const nextDifficulty = (attempts: MasteryAttempt[], start: Difficulty): { level: Difficulty; change: DifficultyChange } => {
  const last = attempts.at(-1);
  const level = last?.difficulty ?? start;
  if (failedTwice(attempts)) return { level: step(level, -1), change: level === 'easy' ? 'kept' : 'lowered' };
  if (last?.result === 'pass' && (last.hintLevel ?? 0) <= RAISE_MAX_HINT_LEVEL) return { level: step(level, 1), change: level === 'hard' ? 'kept' : 'raised' };
  return { level, change: 'kept' };
};

// Stuck: the last two attempts failed and the last was already easy, so
// lowering cannot help. The learner then reviews the concept's notes or
// marks it skipped.
export const isStuck = (attempts: MasteryAttempt[], start: Difficulty): boolean => failedTwice(attempts) && (attempts.at(-1)?.difficulty ?? start) === 'easy';

// ========== Next lab ==========

export type NextConcept = { conceptId: string; difficulty: Difficulty; change: DifficultyChange; stuck: boolean };

// The concept the next lab covers: of the planned concepts on the path not
// yet mastered whose prerequisites have all passed (a prerequisite off the
// path, known or skipped counts as passed), the first in path order whose
// last attempt did not pass; when each of them passed last time, the first
// of them, to make it stick. A concept that just passed once is not
// mastered but goes after the ones still to pass, so the path moves on
// (CARM-33: round-robin passes, priority-sched is next) and later stages
// keep it as regression tests. Null when nothing is left to learn or every
// candidate waits on a prerequisite.
// `only` is a concept the learner picked instead; it is the candidate when
// it is planned and not mastered, prerequisites aside.
// Its difficulty follows its own attempts; a concept not tried yet follows
// the path's latest attempt (the lab just done), else `start`.
export const nextConcept = ({
  path,
  concepts,
  records,
  start,
  only = null,
}: {
  path: PathEntry[];
  concepts: Concept[];
  // By concept id, the course's records.
  records: Map<string, MasteryRecord>;
  start: Difficulty;
  only?: string | null;
}): NextConcept | null => {
  const byId = new Map(concepts.map((concept) => [concept.id, concept]));
  const statusOf = new Map(path.map((entry) => [entry.conceptId, entry.status]));
  const passed = (conceptId: string) => statusOf.get(conceptId) !== 'planned' || (records.get(conceptId)?.totals.pass ?? 0) > 0;
  const open = path.filter(
    (entry) =>
      entry.status === 'planned' &&
      !isMastered(records.get(entry.conceptId) ?? null) &&
      (only ? entry.conceptId === only : (byId.get(entry.conceptId)?.prerequisites ?? []).every(passed)),
  );
  const entry = open.find((candidate) => records.get(candidate.conceptId)?.attempts.at(-1)?.result !== 'pass') ?? open[0];
  if (!entry) return null;
  const own = records.get(entry.conceptId)?.attempts ?? [];
  const latest = path
    .flatMap((candidate) => records.get(candidate.conceptId)?.attempts.slice(-1) ?? [])
    .reduce<MasteryAttempt | null>((newest, attempt) => (!newest || attempt.at > newest.at ? attempt : newest), null);
  const { level, change } = own.length ? nextDifficulty(own, start) : latest ? nextDifficulty([latest], start) : { level: start, change: 'kept' as const };
  return { conceptId: entry.conceptId, difficulty: level, change, stuck: isStuck(own, start) };
};

// ========== Review schedule ==========

// Days until the next review, by box.
export const REVIEW_INTERVALS = [1, 3, 7, 14, 30] as const;
export const MAX_BOX = REVIEW_INTERVALS.length;

const DAY_MS = 24 * 60 * 60 * 1000;

// `day` plus `days` calendar days. Calendar arithmetic on a business day
// string: noon UTC keeps it clear of any offset, so no zone is involved.
export const addDays = (day: string, days: number) => new Date(Date.parse(`${day}T12:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

// A note's first schedule: box 1, due a day after the business day it was written.
export const firstSchedule = (noteId: string, writtenDay: string): ReviewSchedule => ({ noteId, box: 1, dueDay: addDays(writtenDay, REVIEW_INTERVALS[0]) });

// After a review on `today`: remembered moves one box up (the last box
// stays), forgotten goes back to box 1; due again after the box's interval.
export const reviewed = (schedule: ReviewSchedule, remembered: boolean, today: string): ReviewSchedule => {
  const box = remembered ? Math.min(MAX_BOX, schedule.box + 1) : 1;
  return { noteId: schedule.noteId, box, dueDay: addDays(today, REVIEW_INTERVALS[box - 1]) };
};

export const isDue = (schedule: ReviewSchedule, today: string) => schedule.dueDay <= today;

// The schedule of every note that carries concepts: its saved one, or the
// first from the business day the note was written. Notes without concepts
// are not reviewed.
export const schedulesOf = (notes: Pick<NoteMeta, 'id' | 'concepts' | 'createdAt'>[], saved: Map<string, ReviewSchedule>, timeZone: string) =>
  notes.flatMap((note) => (note.concepts.length ? [saved.get(note.id) ?? firstSchedule(note.id, businessDay(new Date(note.createdAt), timeZone))] : []));
