// Mastery: how each concept of each course pack went, global across
// repositories, in userData/mastery.json. One record per (course, concept):
// its last MAX_ATTEMPTS attempts in detail, totals over every attempt ever,
// and the MAX_ERROR_TYPES most frequent error types. An attempt is written
// once a practised package's grade is done, once per concept the package
// carries, and once per submission (repository, package, diffDigest).
//
// [人工决策-2026-10-27 00:36:21] 掌握度一期用简单记录（最近 N 次明细 + 累计 + 错误类型 Top 10），不做 BKT。
// [人工决策-2026-10-27 00:51:12] 掌握度存全局 userData/mastery.json，不按仓库分。
import fs from 'node:fs/promises';
import path from 'node:path';

import { JsonWriteQueue } from './atomic_json_file.ts';
import { isLabConcept } from './project_config.ts';
import { testsPassed } from './practice.ts';
import type { ExecutionMode, GradeReport, Review } from '../shared/ipc/packages.ts';

export const MASTERY_FILENAME = 'mastery.json';
const MASTERY_VERSION = 1;
export const MAX_ATTEMPTS = 20;
export const MAX_ERROR_TYPES = 10;
// Records kept; the least recently attempted go first beyond this.
export const MAX_RECORDS = 2000;
// Submissions remembered for de-duplication, oldest forgotten first.
export const MAX_SEEN = 5000;

export type AttemptResult = 'pass' | 'partial' | 'fail';

export type MasteryAttempt = {
  at: string;
  packageId: string;
  repoId: string;
  result: AttemptResult;
  // Independence score 0–100; null until grades carry one (T10).
  independence: number | null;
  errorTypes: string[];
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

type SavedState = { version: number; records: MasteryRecord[]; seen: string[] };

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

export class MasteryStore {
  #file: string;
  #records = new Map<string, MasteryRecord>();
  #seen = new Set<string>();
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
      independence: null,
      errorTypes: errorTypesOf(submission.report),
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
      value: { version: MASTERY_VERSION, records: [...this.#records.values()], seen: [...this.#seen] } satisfies SavedState,
    }));
}
