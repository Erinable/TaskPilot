// Mastery: how each concept of each course pack went, global across
// repositories, in userData/mastery.json. One record per (course, concept):
// its last MAX_ATTEMPTS attempts in detail, totals over every attempt ever,
// and the MAX_ERROR_TYPES most frequent error types. An attempt is written
// once a practised package's grade is done, once per concept the package
// carries, and once per submission (repository, package, diffDigest).
// Beside the records, the review schedule of notes that carry concepts
// (./lab_progress.ts), one entry per note reviewed at least once.
//
// [人工决策-2026-10-27 00:36:21] 掌握度一期用简单记录（最近 N 次明细 + 累计 + 错误类型 Top 10），不做 BKT。
// [人工决策-2026-10-27 00:51:12] 掌握度存全局 userData/mastery.json，不按仓库分。
import fs from 'node:fs/promises';
import path from 'node:path';

import { JsonWriteQueue } from './atomic_json_file.ts';
import { isLabConcept } from './project_config.ts';
import { testsPassed } from './practice.ts';
import { MAX_NOTES } from './note_store.ts';
import type { ReviewSchedule } from '../shared/ipc/mastery.ts';
import type { Difficulty, ExecutionMode, GradeReport, Review } from '../shared/ipc/packages.ts';

export const MASTERY_FILENAME = 'mastery.json';
const MASTERY_VERSION = 1;
export const MAX_ATTEMPTS = 20;
export const MAX_ERROR_TYPES = 10;
// Records kept; the least recently attempted go first beyond this.
export const MAX_RECORDS = 2000;
// Submissions remembered for de-duplication, oldest forgotten first.
export const MAX_SEEN = 5000;
// Review schedules kept: one per note at most.
export const MAX_SCHEDULES = MAX_NOTES;

export type AttemptResult = 'pass' | 'partial' | 'fail';

export type MasteryAttempt = {
  at: string;
  packageId: string;
  repoId: string;
  result: AttemptResult;
  // Independence score 0–100 from the grade (./grade_scores.ts); null on
  // attempts recorded before grades carried one.
  independence: number | null;
  errorTypes: string[];
  // The package's difficulty and the highest hint level opened (null for
  // none), for the next lab's difficulty; absent on attempts written before.
  difficulty?: Difficulty | null;
  hintLevel?: number | null;
};

export type MasteryRecord = {
  course: string;
  conceptId: string;
  // Newest last, at most MAX_ATTEMPTS.
  attempts: MasteryAttempt[];
  // Over every attempt ever, the ones dropped from `attempts` included.
  totals: { attempts: number; pass: number; partial: number; fail: number };
  // Most frequent first, at most MAX_ERROR_TYPES.
  errorCounts: { type: string; count: number }[];
};

type SavedState = { version: number; records: MasteryRecord[]; seen: string[]; reviews: ReviewSchedule[] };

// Tests that ran in the review's blocking checks, the hidden ones included.
const testCounts = (review: Review & { status: 'passed' | 'rejected' }) => {
  let passed = 0;
  let total = 0;
  for (const check of review.checks) {
    if (!check.blocking || !check.run || 'error' in check.run) continue;
    passed += check.run.summary.passed;
    total += check.run.summary.total;
  }
  return { passed, total };
};

// pass: every test passed and QA accepted; partial: more than half the
// tests passed; anything else, or a review that did not finish, is fail.
export const attemptResult = (review: Review | null): AttemptResult => {
  if (!review || (review.status !== 'passed' && review.status !== 'rejected')) return 'fail';
  if (review.status === 'passed' && testsPassed(review)) return 'pass';
  const { passed, total } = testCounts(review);
  return total > 0 && passed * 2 > total ? 'partial' : 'fail';
};

// The grade's rubric categories, then Tutor's error tags, each once.
export const errorTypesOf = (report: Pick<GradeReport, 'comments' | 'errorTags'>): string[] => [
  ...new Set([...report.comments.map((comment) => comment.category), ...(report.errorTags ?? [])]),
];

export type GradedSubmission = {
  mode: ExecutionMode | null;
  course: string;
  concepts: string[];
  packageId: string;
  repoId: string;
  diffDigest: string;
  review: Review | null;
  report: Pick<GradeReport, 'comments' | 'errorTags'>;
  // The grade's independence score; null when it has none.
  independence?: number | null;
  difficulty: Difficulty | null;
  hintLevel: number | null;
  at: string;
};

// One submission, as seen by de-duplication.
const seenKey = ({ repoId, packageId, diffDigest }: Pick<GradedSubmission, 'repoId' | 'packageId' | 'diffDigest'>) =>
  [repoId, packageId, diffDigest].map((part) => part.replaceAll('\u0000', '')).join('\u0000');

// The concepts a submission counts for; none for a package not practised
// (Coding Agent wrote it) or one without concepts.
export const conceptsToRecord = ({ mode, concepts }: Pick<GradedSubmission, 'mode' | 'concepts'>): string[] =>
  mode === 'practice' ? [...new Set(concepts.filter(isLabConcept))] : [];

const emptyRecord = (course: string, conceptId: string): MasteryRecord => ({
  course,
  conceptId,
  attempts: [],
  totals: { attempts: 0, pass: 0, partial: 0, fail: 0 },
  errorCounts: [],
});

// The record with one more attempt: detail beyond MAX_ATTEMPTS dropped
// (totals already count it), error counts cut to the top MAX_ERROR_TYPES.
// Equal counts keep the type seen last, so a mistake that keeps coming back
// is not cut at 1 every time and can build up.
export const addAttempt = (record: MasteryRecord, attempt: MasteryAttempt): MasteryRecord => {
  // Insertion order is recency: a type seen now moves to the end.
  const counts = new Map(record.errorCounts.toReversed().map((entry) => [entry.type, entry.count]));
  for (const type of attempt.errorTypes) {
    const count = (counts.get(type) ?? 0) + 1;
    counts.delete(type);
    counts.set(type, count);
  }
  return {
    ...record,
    attempts: [...record.attempts, attempt].slice(-MAX_ATTEMPTS),
    totals: { ...record.totals, attempts: record.totals.attempts + 1, [attempt.result]: record.totals[attempt.result] + 1 },
    errorCounts: [...counts]
      .toReversed()
      // Stable: equal counts stay newest first.
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_ERROR_TYPES)
      .map(([type, count]) => ({ type, count })),
  };
};

const recordKey = (course: string, conceptId: string) => `${course}\u0000${conceptId}`;

const isRecord = (value: unknown): value is MasteryRecord => {
  const record = value as MasteryRecord | null;
  return typeof record?.course === 'string' && typeof record.conceptId === 'string' && Array.isArray(record.attempts) && Boolean(record.totals);
};

const isSchedule = (value: unknown): value is ReviewSchedule => {
  const schedule = value as ReviewSchedule | null;
  return (
    typeof schedule?.noteId === 'string' && Number.isInteger(schedule.box) && typeof schedule.dueDay === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(schedule.dueDay)
  );
};

export class MasteryStore {
  #file: string;
  #records = new Map<string, MasteryRecord>();
  #seen = new Set<string>();
  #reviews = new Map<string, ReviewSchedule>();
  #writes = new JsonWriteQueue();

  constructor(configDir: string) {
    this.#file = path.join(configDir, MASTERY_FILENAME);
  }

  async load(): Promise<this> {
    try {
      const saved = JSON.parse(await fs.readFile(this.#file, 'utf8')) as Partial<SavedState> | null;
      for (const record of (Array.isArray(saved?.records) ? saved.records : []).filter(isRecord)) {
        this.#records.set(recordKey(record.course, record.conceptId), record);
      }
      this.#seen = new Set((Array.isArray(saved?.seen) ? saved.seen : []).filter((key) => typeof key === 'string'));
      for (const schedule of (Array.isArray(saved?.reviews) ? saved.reviews : []).filter(isSchedule)) this.#reviews.set(schedule.noteId, schedule);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      if (error instanceof SyntaxError) console.error('[mastery] mastery.json is not valid JSON; starting empty', error);
    }
    return this;
  }

  flush(): Promise<void> {
    return this.#writes.flush();
  }

  list(): MasteryRecord[] {
    return structuredClone([...this.#records.values()]);
  }

  get(course: string, conceptId: string): MasteryRecord | null {
    const record = this.#records.get(recordKey(course, conceptId));
    return record ? structuredClone(record) : null;
  }

  // One course's records, by concept id.
  ofCourse(course: string): Map<string, MasteryRecord> {
    const records = new Map<string, MasteryRecord>();
    for (const record of this.#records.values()) if (record.course === course) records.set(record.conceptId, structuredClone(record));
    return records;
  }

  // Every note's saved review schedule, by note id.
  reviews(): Map<string, ReviewSchedule> {
    return new Map([...this.#reviews].map(([noteId, schedule]) => [noteId, { ...schedule }]));
  }

  // Saves a note's schedule after a review. Schedules of notes not in
  // `noteIds` (deleted, renamed or without concepts now) are dropped.
  async setReview(schedule: ReviewSchedule, noteIds: Set<string>): Promise<void> {
    for (const noteId of this.#reviews.keys()) if (!noteIds.has(noteId)) this.#reviews.delete(noteId);
    this.#reviews.delete(schedule.noteId);
    this.#reviews.set(schedule.noteId, { ...schedule });
    for (const old of [...this.#reviews.keys()].slice(0, Math.max(0, this.#reviews.size - MAX_SCHEDULES))) this.#reviews.delete(old);
    await this.#persist();
    console.debug(`[mastery] review note=${schedule.noteId} box=${schedule.box} due=${schedule.dueDay}`);
  }

  // Writes one attempt per concept of a graded submission; returns the
  // concepts written, none when it was not practised, has no concepts or
  // was recorded before.
  async record(submission: GradedSubmission): Promise<string[]> {
    const concepts = conceptsToRecord(submission);
    const key = seenKey(submission);
    if (!concepts.length || this.#seen.has(key)) return [];
    const attempt: MasteryAttempt = {
      at: submission.at,
      packageId: submission.packageId,
      repoId: submission.repoId,
      result: attemptResult(submission.review),
      independence: submission.independence ?? null,
      errorTypes: errorTypesOf(submission.report),
      difficulty: submission.difficulty,
      hintLevel: submission.hintLevel,
    };
    for (const conceptId of concepts) {
      const id = recordKey(submission.course, conceptId);
      const next = addAttempt(this.#records.get(id) ?? emptyRecord(submission.course, conceptId), attempt);
      // Re-inserted, so the map stays in order of the latest attempt.
      this.#records.delete(id);
      this.#records.set(id, next);
    }
    this.#seen.add(key);
    for (const old of [...this.#records.keys()].slice(0, Math.max(0, this.#records.size - MAX_RECORDS))) this.#records.delete(old);
    for (const old of [...this.#seen].slice(0, Math.max(0, this.#seen.size - MAX_SEEN))) this.#seen.delete(old);
    await this.#persist();
    console.debug(`[mastery] record package=${submission.packageId} course=${submission.course} concepts=${concepts.join(',')} result=${attempt.result}`);
    return concepts;
  }

  #persist = () =>
    this.#writes.write(() => ({
      file: this.#file,
      value: {
        version: MASTERY_VERSION,
        records: [...this.#records.values()],
        seen: [...this.#seen],
        reviews: [...this.#reviews.values()],
      } satisfies SavedState,
    }));
}
