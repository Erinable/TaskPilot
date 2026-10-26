#!/usr/bin/env node
// Runs Tutor's grading against the eval cases with the real Claude CLI.
//
//   npm run eval:tutor-grade                         each case with its own pack
//   npm run eval:tutor-grade -- --course programming every case with one pack
//   npm run eval:tutor-grade -- --case os-counter-volatile
//   npm run eval:tutor-grade -- --label v2           names the report
//   npm run eval:tutor-grade -- --no-judge           checks only
//
// Costs real money, so it is not part of `npm test`. Reports go to
// evals/tutor-grade/reports/ (gitignored).
import { BUILTIN_COURSES } from '../../src/shared/course_pack.ts';
import { judgeWith, parseArgs, runAgent, runSuite } from '../shared/harness.ts';
import { cases } from './cases.ts';
import { check, structure } from './checks.ts';
import { gradeCase } from './grade.ts';
import type { GradeCase } from './cases.ts';
import type { GradeRun } from './grade.ts';
import type { CaseOutcome } from '../shared/harness.ts';
import type { CoursePack } from '../../src/shared/course_pack.ts';

const CRITERIA = {
  accuracy: 'Every comment describes something really in the submission, at the right file and line. No invented problems, no QA issues repeated as if new.',
  lessonFound:
    'The grade names the planted lesson (see <planted>) clearly enough that the student would learn it. For a clean submission: it says so and adds nothing wrong.',
  rubricFit:
    'Each comment sits under the rubric item whose description fits it best, using the rubric in <rubric>. A comment that fits none counts against this.',
  teaching: 'Each betterWay says what to do instead and why, in plain words a student at this level understands, tied to the mechanism or technique involved.',
  calibration: 'Few, important comments; fair strengths; repeated is true only when a developer note already describes that mistake.',
};
type Criterion = keyof typeof CRITERIA;

const SYSTEM = [
  'You are a strict reviewer of a tutoring agent. You see a work package, the student’s submission, the reference solution, QA’s verdict, the student’s notes, the rubric the tutor graded with, what was planted in the submission, and the tutor’s grade.',
  'Score each criterion from 1 (poor) to 5 (excellent). 3 means acceptable with clear flaws. Reserve 5 for a grade you would not change.',
  'Give a one-sentence reason naming the specific flaw or strength. Write reasons in English.',
].join('\n');

const packById = (id: string): CoursePack => {
  const pack = BUILTIN_COURSES.find((entry) => entry.id === id);
  if (!pack) throw new Error(`--course: "${id}" is not a built-in course pack; use one of ${BUILTIN_COURSES.map((entry) => entry.id).join(', ')}`);
  return pack;
};

type Run = { course: string; report: GradeRun['report'] };

const judgePrompt = (testCase: GradeCase, course: CoursePack, run: GradeRun) =>
  [
    '<work_package>',
    JSON.stringify(testCase.task, null, 2),
    '</work_package>',
    '',
    '<submission>',
    run.submission.map((file) => `<file path="${file.path}">\n${file.patch}\n</file>`).join('\n\n'),
    '</submission>',
    '',
    '<reference_solution>',
    run.reference ?? '(none)',
    '</reference_solution>',
    '',
    '<qa_review>',
    JSON.stringify(testCase.review, null, 2),
    '</qa_review>',
    '',
    '<developer_notes>',
    JSON.stringify(testCase.notes ?? [], null, 2),
    '</developer_notes>',
    '',
    '<rubric>',
    course.rubric.map((item) => `${item.id} (${item.label}): ${item.description}`).join('\n'),
    '</rubric>',
    '',
    '<planted>',
    testCase.planted,
    '</planted>',
    '',
    '<grade>',
    JSON.stringify(run.report, null, 2),
    '</grade>',
  ].join('\n');

const args = parseArgs(process.argv.slice(2));
const forced = args.course ? packById(args.course) : null;
const packFor = (testCase: GradeCase) => forced ?? packById(testCase.course);

const runCase = async (testCase: GradeCase, { judge }: { judge: boolean }): Promise<CaseOutcome<Run, Criterion>> => {
  const started = Date.now();
  const course = packFor(testCase);
  const graded = await gradeCase(testCase, course, runAgent);
  let scores = null;
  let judgeCostUsd = 0;
  if (judge) {
    const judged = await judgeWith<Criterion>(CRITERIA, SYSTEM, judgePrompt(testCase, course, graded));
    scores = judged.scores;
    judgeCostUsd = judged.costUsd;
  }
  return {
    id: testCase.id,
    seconds: Math.round((Date.now() - started) / 1000),
    agentCostUsd: graded.costUsd,
    judgeCostUsd,
    run: { course: course.id, report: graded.report },
    checks: check(testCase, graded.report, course),
    scores,
  };
};

// Rubric coverage and balance, per pack the cases were graded with.
const suite = (results: CaseOutcome<Run, Criterion>[]) =>
  Object.fromEntries(
    [...new Set(results.map((result) => result.run.course))].map((id) => [
      id,
      structure(
        packById(id),
        results.filter((result) => result.run.course === id).map((result) => result.run.report),
      ),
    ]),
  );

runSuite({ suiteDir: import.meta.dirname, cases, criteria: Object.keys(CRITERIA) as Criterion[], runCase, suite }).catch((error) => {
  console.error(error);
  process.exit(1);
});
