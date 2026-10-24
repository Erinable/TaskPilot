// Practice mode's pure rules: where a reference patch is kept, what Tutor
// is shown when grading, and when a submission needs grading at all.
//
// [人工决策-2026-10-24 12:51:21] 练习模式先交卷再看参考答案：参考答案在领取时后台生成，
// 首次提交审查前主进程不返回补丁；QA 出结论后（通过或驳回）由 Tutor 判卷，判卷不改变工作包状态。
import { createHash } from 'node:crypto';
import path from 'node:path';

import type { Grade, Review } from '../shared/ipc_types.ts';

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
