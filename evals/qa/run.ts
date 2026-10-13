#!/usr/bin/env node
// Runs QA's review against the eval cases with the real Claude CLI.
//
//   npm run eval:qa                        all cases
//   npm run eval:qa -- --case sql-injection one case
//   npm run eval:qa -- --label v2          names the report
//   npm run eval:qa -- --no-judge          checks only
//
// Costs real money, so it is not part of `npm test`. Reports go to
// evals/qa/reports/ (gitignored).
import fs from 'node:fs/promises';
import path from 'node:path';

import { reviewWorkPackage } from '../../src/main/agents/pipeline.ts';
import { TS_API } from '../product-lead/sources.ts';
import { fixtureRepo, judgeWith, runAgent, runSuite } from '../shared/harness.ts';
import { cases } from './cases.ts';
import { check } from './checks.ts';
import type { QaCase } from './cases.ts';
import type { ReviewResult } from '../../src/main/agents/pipeline.ts';

const CRITERIA = {
  issueAccuracy: 'Every issue describes a real problem in the diff, at the right file and line. No invented problems.',
  severity: 'Severities match impact: security holes and broken requirements are blockers or major, style is minor.',
  actionability: 'A developer could fix each issue from its text alone, without re-reviewing the diff.',
  criteriaJudgement: 'Each acceptance criterion is judged met, unmet or unclear correctly from the diff and the test evidence.',
};
type Criterion = keyof typeof CRITERIA;

const SYSTEM = [
  'You are a strict reviewer of a code-review agent. You see a work package, the diff the developer submitted, and the review the agent wrote.',
  'Score each criterion from 1 (poor) to 5 (excellent). 3 means acceptable with clear flaws. Reserve 5 for a review you would not change.',
  'Give a one-sentence reason naming the specific flaw or strength. Write reasons in English.',
].join('\n');

type Run = Pick<ReviewResult, 'passed' | 'reasons' | 'report' | 'acceptance'>;

// The fixed test run: every case test passes.
const testRun = (names: string[]) => ({
  kind: 'test' as const,
  command: 'npm test',
  exitCode: 0,
  timedOut: false,
  durationMs: 100,
  output: names.map((name, index) => `ok ${index + 1} - ${name}`).join('\n'),
  results: names.map((name) => ({ name, passed: true, skipped: false, todo: false })),
  summary: { total: names.length, passed: names.length, failed: 0, skipped: 0, ok: true },
  report: { format: 'stdout' as const, trusted: true, problem: null },
  check: { stage: 'submit' as const, blocking: true },
});

const runCase = async (testCase: QaCase, { judge }: { judge: boolean }) => {
  const started = Date.now();
  const repo = await fixtureRepo(testCase.id, TS_API);
  let review: ReviewResult;
  let diffText = '';
  try {
    for (const [file, content] of Object.entries(testCase.change)) await fs.writeFile(path.join(repo.root, file), content);
    review = await reviewWorkPackage(testCase.task, {
      root: repo.root,
      baseline: repo.head,
      runAgent,
      checks: [{ kind: 'test', stage: 'submit', blocking: true, line: 'npm test' }],
      runCheck: async () => testRun(testCase.passingTests),
    });
    diffText = Object.entries(testCase.change)
      .map(([file, content]) => `<file path="${file}">\n${content}\n</file>`)
      .join('\n\n');
  } finally {
    await repo.cleanup();
  }
  const run: Run = { passed: review.passed, reasons: review.reasons, report: review.report, acceptance: review.acceptance };
  let scores = null;
  let judgeCostUsd = 0;
  if (judge && review.report) {
    const judged = await judgeWith<Criterion>(
      CRITERIA,
      SYSTEM,
      [
        '<work_package>',
        JSON.stringify(testCase.task, null, 2),
        '</work_package>',
        '',
        '<changed_files_after>',
        diffText,
        '</changed_files_after>',
        '',
        '<review>',
        JSON.stringify(review.report, null, 2),
        '</review>',
      ].join('\n'),
    );
    scores = judged.scores;
    judgeCostUsd = judged.costUsd;
  }
  return {
    id: testCase.id,
    seconds: Math.round((Date.now() - started) / 1000),
    agentCostUsd: review.costUsd,
    judgeCostUsd,
    run,
    checks: check(testCase, review),
    scores,
  };
};

runSuite({ suiteDir: import.meta.dirname, cases, criteria: Object.keys(CRITERIA) as Criterion[], runCase }).catch((error) => {
  console.error(error);
  process.exit(1);
});
