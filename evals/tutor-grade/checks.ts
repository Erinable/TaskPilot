// Deterministic checks on Tutor's grades. Per case: the planted lesson is
// located and marked under the right rubric item, repeated is set only when
// a note describes the mistake, and clean submissions get few comments. Per
// pack, across its cases: every rubric item is used and no one item takes
// almost every comment. The judge (run.ts) scores how good the teaching is.
import type { CheckResult } from '../shared/harness.ts';
import type { GradeCase } from './cases.ts';
import type { GradeReport } from '../../src/main/agents/tutor_grade.ts';
import type { CoursePack } from '../../src/shared/course_pack.ts';

// One item may take at most this share of a pack's comments.
const MAX_SHARE = 0.7;
// Fewer comments than this say nothing about the distribution.
const MIN_FOR_BALANCE = 6;

const comments = (report: GradeReport) =>
  report.comments.map((comment) => `[${comment.category}] ${comment.file ?? '-'}${comment.repeated ? ' repeated' : ''}`).join(' | ');

// `course` is the pack the grade was made with; the case's categories only
// hold for its own pack.
export const check = (testCase: Pick<GradeCase, 'course' | 'expect' | 'notes'>, report: GradeReport, course: CoursePack): Record<string, CheckResult> => {
  const { expect } = testCase;
  const results: Record<string, CheckResult> = {};
  const rubricIds = course.rubric.map((item) => item.id);
  // validateGrade already refuses other ids; this keeps the report readable.
  results.rubricIds = {
    pass: report.comments.every((comment) => rubricIds.includes(comment.category)),
    detail: comments(report) || 'no comments',
  };
  if (expect.file) {
    const located = report.comments.filter((comment) => comment.file === expect.file);
    results.located = {
      pass: located.length > 0,
      detail: located.length ? `${located.length} on ${expect.file}` : `none on ${expect.file}: ${comments(report)}`,
    };
    if (expect.categories && testCase.course === course.id) {
      const fits = located.some((comment) => expect.categories!.includes(comment.category));
      results.category = { pass: fits, detail: `want one of ${expect.categories.join(', ')}: ${comments(report)}` };
    }
  }
  if (expect.repeated !== undefined) {
    const repeated = report.comments.filter((comment) => comment.repeated);
    results.repeated = {
      pass: expect.repeated ? repeated.length > 0 : repeated.length === 0,
      detail: `${repeated.length} repeated (want ${expect.repeated ? 'some' : 'none'})`,
    };
  }
  if (expect.maxComments !== undefined)
    results.quiet = { pass: report.comments.length <= expect.maxComments, detail: `${report.comments.length} comments (want at most ${expect.maxComments})` };
  return results;
};

// How one pack's rubric was used across its cases' grades.
export const structure = (course: CoursePack, reports: GradeReport[]) => {
  const counts = Object.fromEntries(course.rubric.map((item) => [item.id, 0]));
  for (const report of reports) for (const comment of report.comments) counts[comment.category] = (counts[comment.category] ?? 0) + 1;
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const unused = course.rubric.filter((item) => counts[item.id] === 0).map((item) => item.id);
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  const share = total ? top[1] / total : 0;
  const byDimension = Object.fromEntries(course.rubric.map((item) => [item.dimension, 0]));
  for (const item of course.rubric) byDimension[item.dimension] += counts[item.id];
  return {
    course: course.id,
    comments: total,
    counts,
    byDimension,
    checks: {
      coverage: { pass: unused.length === 0, detail: unused.length ? `unused: ${unused.join(', ')}` : 'every rubric item used' },
      balance: {
        pass: total < MIN_FOR_BALANCE || share <= MAX_SHARE,
        detail: total < MIN_FOR_BALANCE ? `only ${total} comments` : `${top[0]} has ${Math.round(share * 100)}% (at most ${MAX_SHARE * 100}%)`,
      },
    } as Record<string, CheckResult>,
  };
};
