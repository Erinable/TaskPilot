// Lab generator eval: generates the first lab for each case with the real
// Claude CLI (two calls, ./lab_generator.ts's generate), turns it into a lab
// artifact as the app does, then runs `make grade` on the starter code and
// on the reference with the hidden tests. Needs cc and make.
//
//   npm run eval:lab-gen                         every case, ~$10–14, no judge
//   npm run eval:lab-gen -- --case round-robin
//   npm run eval:lab-gen -- --label my-change
//   npm run eval:lab-gen -- --verify             also the app's self-check with repairs (T5), every case ~$22–25
import path from 'node:path';

import * as generator from '../../src/main/agents/lab_generator.ts';
import * as verifier from '../../src/main/agents/lab_verifier.ts';
import * as labVerify from '../../src/main/courses/lab_verify.ts';
import { sandboxProbe } from '../../src/main/courses/lab_toolchain.ts';
import * as courses from '../../src/main/courses/courses.ts';
import { toLabArtifact } from '../../src/main/courses/lab_artifact.ts';
import { runAgent, runSuite } from '../shared/harness.ts';
import { cases, requestFor } from './cases.ts';
import { check, runLab } from './checks.ts';
import type { CaseOutcome } from '../shared/harness.ts';
import type { LabCase } from './cases.ts';
import type { LabRun } from './checks.ts';
import type { RunAgent } from '../../src/main/runtimes/claude_cli.ts';

const BUILTIN = await courses.loadBuiltinCourses(path.join(import.meta.dirname, '..', '..', courses.BUILTIN_COURSES_DIR));
const OS = BUILTIN.get('os')!.pack;

const VERIFY = process.argv.includes('--verify');

// `calls` is what the CLI reported per call, for calibrating the app's estimate.
type Run = {
  lab: generator.GeneratedLab | null;
  error: string | null;
  grade: LabRun | null;
  verify: labVerify.LabVerifyReport | null;
  calls: { costUsd: number | null; tokens: unknown }[];
};

// The self-check as the app runs it after generating, with real calls.
const selfCheck = (request: generator.LabRequest, lab: generator.GeneratedLab, counted: RunAgent) =>
  labVerify.verifyLab(
    lab,
    { stage: request.stage, base: labVerify.FIRST_STAGE_BASE, toolchain: request.toolchain, programs: [] },
    {
      grade: labVerify.sandboxGrader(),
      probe: sandboxProbe(),
      writeMutants: (current) => verifier.writeMutants(request, current, { runAgent: counted }),
      judge: (current) => verifier.judgeConsistency(request, current, { runAgent: counted }),
      repair: (current, failure) => generator.repair(request, current, failure, { runAgent: counted }),
    },
  );

const runCase = async (testCase: LabCase): Promise<CaseOutcome<Run, never>> => {
  const started = Date.now();
  const request = requestFor(testCase, OS);
  let lab: generator.GeneratedLab | null = null;
  let error: string | null = null;
  let grade: LabRun | null = null;
  let verify: labVerify.LabVerifyReport | null = null;
  let costUsd = 0;
  const calls: Run['calls'] = [];
  // Spend is counted per call, so a lab refused after its first call still costs.
  const counted: typeof runAgent = async (options) => {
    const result = await runAgent(options);
    costUsd += result.costUsd ?? 0;
    calls.push({ costUsd: result.costUsd, tokens: result.call?.tokens ?? null });
    return result;
  };
  try {
    lab = (await generator.generate(request, { runAgent: counted })).lab;
    grade = await runLab(await toLabArtifact(lab, request), request.toolchain);
    if (VERIFY) verify = (await selfCheck(request, lab, counted)).report;
  } catch (caught) {
    const coded = caught as Error & { code?: string };
    error = `${coded.code ?? ''} ${coded.message}`.trim();
  }
  return {
    id: testCase.id,
    seconds: Math.round((Date.now() - started) / 1000),
    agentCostUsd: costUsd,
    judgeCostUsd: 0,
    run: { lab, error, grade, verify, calls },
    checks: {
      ...check(lab, error, grade),
      ...(VERIFY
        ? {
            selfCheck: {
              pass: verify?.status === 'passed',
              detail: verify ? `${verify.status} after ${verify.rounds.length} round(s), $${verify.costUsd.toFixed(2)}` : 'not run',
            },
          }
        : {}),
    },
    scores: null,
  };
};

const percent = (count: number, total: number) => (total ? Math.round((count / total) * 100) : null);

// With --verify, what the app would show per lab: ready after the first
// round, ready after repairs, needs_review, or failed (the generation was
// refused, so no self-check ran). Rounds and cost are over the labs that
// were checked; cost is generation and self-check together.
const selfCheckSuite = (results: CaseOutcome<Run, never>[]) => {
  const checked = results.filter((result) => result.run.verify);
  const reports = checked.map((result) => result.run.verify!);
  const firstRound = reports.filter((report) => report.status === 'passed' && report.rounds.length === 1).length;
  const needsReview = reports.filter((report) => report.status === 'needs_review').length;
  const rounds = reports.reduce((sum, report) => sum + report.rounds.length, 0);
  const cost = checked.reduce((sum, result) => sum + result.agentCostUsd, 0);
  return {
    selfCheckPassed: `${reports.length - needsReview}/${results.length}`,
    firstRoundPassRate: percent(firstRound, results.length),
    needsReviewRate: percent(needsReview, results.length),
    failedRate: percent(results.length - checked.length, results.length),
    meanRounds: checked.length ? Math.round((rounds / checked.length) * 100) / 100 : null,
    meanLabCostUsd: checked.length ? Math.round((cost / checked.length) * 100) / 100 : null,
  };
};

// The eval's target: the share of cases whose first lab runs.
const suite = (results: CaseOutcome<Run, never>[]) => {
  const runs = results.filter((result) => result.checks.runs?.pass).length;
  return {
    firstRoundRuns: `${runs}/${results.length}`,
    firstRoundRunRate: percent(runs, results.length),
    ...(VERIFY ? selfCheckSuite(results) : {}),
  };
};

runSuite({ suiteDir: import.meta.dirname, cases, criteria: [], runCase, suite }).catch((error) => {
  console.error(error);
  process.exit(1);
});
