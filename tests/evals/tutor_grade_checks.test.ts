import { test } from 'vitest';
import assert from 'node:assert/strict';

import { cases } from '../../evals/tutor-grade/cases.ts';
import { check, structure } from '../../evals/tutor-grade/checks.ts';
import { gradeCase } from '../../evals/tutor-grade/grade.ts';
import { BUILTIN_COURSES, OS_COURSE, PROGRAMMING_COURSE } from '../../src/shared/course_pack.ts';
import type { GradeReport } from '../../src/main/agents/tutor.ts';

const comment = (category: string, file: string | null = null, repeated = false) => ({
  category,
  file,
  line: null,
  observation: 'o',
  betterWay: 'b',
  repeated,
});
const report = (comments: GradeReport['comments']): GradeReport => ({ summary: 's', strengths: [], comments });
const byId = (id: string) => cases.find((testCase) => testCase.id === id)!;
const failing = (results: Record<string, { pass: boolean }>) =>
  Object.entries(results)
    .filter(([, result]) => !result.pass)
    .map(([name]) => name);

test('every built-in pack has five to ten grading cases, with well-formed expectations', () => {
  const ids = new Set<string>();
  for (const pack of BUILTIN_COURSES) {
    const own = cases.filter((testCase) => testCase.course === pack.id);
    assert.ok(own.length >= 5 && own.length <= 10, `${pack.id}: ${own.length} cases`);
    const rubricIds = pack.rubric.map((item) => item.id);
    for (const testCase of own) {
      assert.ok(!ids.has(testCase.id), `duplicate ${testCase.id}`);
      ids.add(testCase.id);
      for (const category of testCase.expect.categories ?? []) assert.ok(rubricIds.includes(category), `${testCase.id}: ${category}`);
      if (testCase.expect.file) assert.ok(testCase.expect.file in testCase.submission, `${testCase.id}: ${testCase.expect.file} is not submitted`);
      if (testCase.expect.repeated !== undefined) assert.ok(testCase.notes?.length, `${testCase.id}: repeated needs notes`);
      for (const file of Object.keys(testCase.submission)) {
        assert.ok(file in testCase.fixture, `${testCase.id}: ${file} is not in the fixture`);
        assert.ok(testCase.task.fileScope.includes(file), `${testCase.id}: ${file} is out of scope`);
        assert.notEqual(testCase.submission[file], testCase.fixture[file], `${testCase.id}: ${file} is unchanged`);
      }
    }
    // Each rubric item is planted in at least one case, so coverage can pass.
    for (const id of rubricIds)
      assert.ok(
        own.some((testCase) => testCase.expect.categories?.includes(id)),
        `${pack.id}: no case plants ${id}`,
      );
  }
});

test('the checks find the planted lesson under the right rubric item', () => {
  const volatile = byId('os-counter-volatile');
  assert.deepEqual(failing(check(volatile, report([comment('safety', 'src/counter.c')]), OS_COURSE)), []);
  assert.deepEqual(failing(check(volatile, report([comment('mechanism', 'src/counter.c')]), OS_COURSE)), ['category']);
  // The category is read from the comments on the file.
  assert.deepEqual(failing(check(volatile, report([comment('safety', null)]), OS_COURSE)), ['located', 'category']);
  // Graded with another pack, only the location is held to the case.
  assert.deepEqual(failing(check(volatile, report([comment('writing', 'src/counter.c')]), PROGRAMMING_COURSE)), []);
  assert.deepEqual(failing(check(volatile, report([comment('concept', 'src/counter.c')]), PROGRAMMING_COURSE)), ['rubricIds']);
});

test('repeated must match whether a note describes the mistake, and clean cases stay quiet', () => {
  const noted = byId('os-bbuf-if-wait');
  assert.equal(check(noted, report([comment('safety', 'src/bbuf.c')]), OS_COURSE).repeated.pass, false);
  assert.equal(check(noted, report([comment('safety', 'src/bbuf.c', true)]), OS_COURSE).repeated.pass, true);
  const clean = byId('os-copy-clean');
  assert.deepEqual(failing(check(clean, report([comment('mechanism', 'src/copy.c')]), OS_COURSE)), []);
  assert.deepEqual(failing(check(clean, report([comment('mechanism'), comment('concept'), comment('safety', null, true)]), OS_COURSE)), ['repeated', 'quiet']);
});

test('structure reports unused rubric items and one item taking almost every comment', () => {
  const even = structure(OS_COURSE, [report([comment('concept'), comment('mechanism'), comment('safety')])]);
  assert.deepEqual(even.counts, { concept: 1, mechanism: 1, safety: 1 });
  assert.deepEqual(even.byDimension, { thinking: 1, writing: 1, style: 1 });
  assert.ok(even.checks.coverage.pass && even.checks.balance.pass);
  const lopsided = structure(OS_COURSE, [report(Array.from({ length: 8 }, () => comment('mechanism'))), report([comment('concept')])]);
  assert.equal(lopsided.checks.coverage.detail, 'unused: safety');
  assert.equal(lopsided.checks.balance.pass, false);
  assert.match(lopsided.checks.balance.detail, /^mechanism has 89%/);
});

test('every case is graded through the real prompt, schema and validation (stub model)', async () => {
  for (const testCase of cases) {
    const course = BUILTIN_COURSES.find((pack) => pack.id === testCase.course)!;
    let seen = { prompt: '', systemPrompt: '', enum: [] as string[] };
    const graded = await gradeCase(testCase, course, async (options) => {
      seen = { prompt: options.prompt, systemPrompt: options.systemPrompt!, enum: (options.schema as any).properties.comments.items.properties.category.enum };
      const file = Object.keys(testCase.submission)[0];
      return { output: { summary: 's', strengths: [], comments: [comment(course.rubric[0].id, file, true)] }, costUsd: 0 };
    });
    assert.deepEqual(
      seen.enum,
      course.rubric.map((item) => item.id),
      testCase.id,
    );
    assert.match(seen.systemPrompt, new RegExp(`practises real work packages`), testCase.id);
    assert.ok(seen.systemPrompt.includes(course.learner), testCase.id);
    for (const file of Object.keys(testCase.submission))
      assert.ok(seen.prompt.includes(`<file path="${file}">\ndiff --git`), `${testCase.id}: ${file} is not a diff`);
    assert.equal(graded.reference === null, testCase.reference === null, testCase.id);
    if (graded.reference) assert.ok(seen.prompt.includes(graded.reference), testCase.id);
    // The file survives validation only because it is in the submission.
    assert.equal(graded.report.comments[0].file, Object.keys(testCase.submission)[0], testCase.id);
    assert.equal(graded.report.comments[0].repeated, Boolean(testCase.notes?.length), testCase.id);
  }
}, 60_000);
