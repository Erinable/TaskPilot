// Practice mode's pure rules: where a reference patch is kept, when it
// opens, what Tutor is shown when grading, and when a submission needs
// grading at all.
//
// [人工决策-2026-10-27 00:51:12] 参考答案要「本包测试全部通过」或「提示梯度已用到 L5」才解锁，
// 课程 lab 和项目 practice 包同一规则（取代 2026-10-24 12:51:21 的「首次提交后即可看」）。
// 参考答案在领取时后台生成（lab 自带）；QA 出结论后（通过或驳回）由 Tutor 判卷，判卷不改变工作包状态。
import { createHash } from 'node:crypto';
import path from 'node:path';

import * as noteCourses from '../shared/note_courses.ts';
import type { CoursePack } from '../shared/course_pack.ts';
import type { NoteMeta } from '../shared/ipc/notes.ts';
import type { Grade, GradeCategory, ReferenceLock, ReferenceRun, Review } from '../shared/ipc/packages.ts';

export const REFERENCES_DIRNAME = 'references';
// What of the reference Tutor reads; the submission is capped by review_diff.
export const MAX_REFERENCE_PROMPT_BYTES = 64 * 1024;

// One file per package, overwritten by its next reference run.
export const referencePath = (dataDir: string, packageId: string) => path.join(dataDir, REFERENCES_DIRNAME, `${encodeURIComponent(packageId)}.patch`);

// Identifies one submission, so the same change is never graded twice.
export const submissionDigest = (files: { path: string; patch: string }[]): string => {
  const hash = createHash('sha256');
  for (const file of files) hash.update(`${file.path}\u0000${file.patch}\u0000`);
  return hash.digest('hex');
};

// A grade for this submission that is done or on its way needs no new one.
export const alreadyGraded = (grade: Grade | null, digest: string): boolean => Boolean(grade && grade.diffDigest === digest && grade.status !== 'failed');

// The reference as Tutor reads it: whole when small, else cut at a file
// boundary with a note, so a half-file never reads as the solution.
export const referenceForPrompt = (patch: string): string => {
  if (Buffer.byteLength(patch) <= MAX_REFERENCE_PROMPT_BYTES) return patch;
  let kept = '';
  for (const segment of patch.split(/(?=^diff --git )/m)) {
    if (Buffer.byteLength(kept + segment) > MAX_REFERENCE_PROMPT_BYTES) break;
    kept += segment;
  }
  return `${kept}\n(The rest of the reference solution was left out for length.)`;
};

// The top rung of the hint ladder (L1–L5).
const MAX_HINT_LEVEL = 5;

// Whether the package's tests all passed in its latest finished review:
// every blocking check (the repository's submit steps, a lab's public and
// hidden tests) passed, and every acceptance criterion with a linked test
// was verified. QA's own verdict does not count; with nothing to run there
// is nothing that passed.
const testsPassed = (review: Review | null): boolean => {
  if (!review || (review.status !== 'passed' && review.status !== 'rejected')) return false;
  const checks = review.checks.filter((check) => check.blocking);
  const linked = review.acceptance.filter((criterion) => criterion.test);
  if (!checks.length && !linked.length) return false;
  return checks.every((check) => check.status === 'pass') && linked.every((criterion) => criterion.status === 'verified');
};

// The highest hint rung this package has used. The hint ladder is T7's;
// until it lands no rung is ever used, so this condition never opens the
// reference.
export const usedHintLevel = (_state: { referenceRun: ReferenceRun | null }): number | null => null;

// Whether the reference may be read now, and why. `hintLevel` is the
// highest hint rung used, null while there is no hint ladder (before T7),
// which never opens it. Once read it stays open.
export const referenceLock = (
  { referenceRun, review }: { referenceRun: ReferenceRun | null; review: Review | null },
  hintLevel: number | null,
): ReferenceLock | null => {
  if (referenceRun?.status !== 'ready') return null;
  if (referenceRun.revealedAt) return { unlocked: true, reason: 'revealed' };
  if (testsPassed(review)) return { unlocked: true, reason: 'tests_passed' };
  if (hintLevel !== null && hintLevel >= MAX_HINT_LEVEL) return { unlocked: true, reason: 'hints_used' };
  return { unlocked: false, reason: review && review.status !== 'running' ? 'tests_not_passed' : 'not_submitted' };
};

// QA's conclusion in the words Tutor needs; null when QA did not finish.
export const reviewForGrade = (review: Review | null): { passed: boolean; summary: string | null; issues: string[] } | null => {
  if (!review || (review.status !== 'passed' && review.status !== 'rejected')) return null;
  return {
    passed: review.status === 'passed',
    summary: review.report?.summary ?? null,
    issues: (review.report?.issues ?? []).map(
      (issue) => `[${issue.severity}] ${issue.file ? `${issue.file}${issue.line ? `:${issue.line}` : ''} ` : ''}${issue.text}`,
    ),
  };
};

export const MAX_GRADE_NOTES = 10;

// The developer's notes Tutor reads when grading, at most MAX_GRADE_NOTES:
// those about a file this submission changed, then those with a category of
// the pack in use (`course`), then those of other packs whose category maps
// onto a dimension this pack's rubric also has. Notes come newest first from
// the store; `packs` are the packs whose rubrics are known here.
// Tutor reads each note's summary, never its body: a note without one
// stands in with the start of its text. Another pack's note is labelled
// with its dimension, since its own category means nothing in this pack.
// [人工决策-2026-10-26 15:38:21] 先同文件，再同课程包，最后其他包里同一通用维度的笔记。
export const notesForGrade = (
  notes: NoteMeta[],
  changedPaths: string[],
  course: Pick<CoursePack, 'id' | 'rubric'>,
  packs: Pick<CoursePack, 'id' | 'rubric'>[],
): { category: GradeCategory | null; title: string; summary: string }[] => {
  const changed = new Set(changedPaths);
  const dimensions = new Set(course.rubric.map((item) => item.dimension));
  const label = new Map<NoteMeta, GradeCategory | null>();
  const sameFile: NoteMeta[] = [];
  const samePack: NoteMeta[] = [];
  const sameDimension: NoteMeta[] = [];
  for (const note of notes) {
    if (note.source?.file && changed.has(note.source.file)) {
      sameFile.push(note);
      label.set(note, noteCourses.noteCourseId(note) === course.id ? note.category : (noteCourses.dimensionOf(note, packs) ?? note.category));
    } else if (note.category && noteCourses.noteCourseId(note) === course.id) {
      samePack.push(note);
      label.set(note, note.category);
    } else {
      const dimension = note.category ? noteCourses.dimensionOf(note, packs) : null;
      if (!dimension || !dimensions.has(dimension)) continue;
      sameDimension.push(note);
      label.set(note, dimension);
    }
  }
  return [...sameFile, ...samePack, ...sameDimension]
    .slice(0, MAX_GRADE_NOTES)
    .map((note) => ({ category: label.get(note) ?? null, title: note.title, summary: note.summary ?? note.excerpt }));
};
