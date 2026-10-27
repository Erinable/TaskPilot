// Lab generator eval: generates the first lab for each case with the real
// Claude CLI (two calls, ./lab_generator.ts's generate), turns it into a lab
// artifact as the app does, then runs `make grade` on the starter code and
// on the reference with the hidden tests. Needs cc and make.
//
//   npm run eval:lab-gen                         every case, ~$6, no judge
//   npm run eval:lab-gen -- --case round-robin
//   npm run eval:lab-gen -- --label my-change
import path from 'node:path';

import * as generator from '../../src/main/agents/lab_generator.ts';
import * as courses from '../../src/main/courses.ts';
import { toLabArtifact } from '../../src/main/lab_generation_service.ts';
import { runAgent, runSuite } from '../shared/harness.ts';
import { cases, requestFor } from './cases.ts';
import { check, runLab } from './checks.ts';
import type { CaseOutcome } from '../shared/harness.ts';
import type { LabCase } from './cases.ts';
import type { LabRun } from './checks.ts';

const BUILTIN = await courses.loadBuiltinCourses(path.join(import.meta.dirname, '..', '..', courses.BUILTIN_COURSES_DIR));
const OS = BUILTIN.get('os')!.pack;

// `calls` is what the CLI reported per call, for calibrating the app's estimate.
type Run = { lab: generator.GeneratedLab | null; error: string | null; grade: LabRun | null; calls: { costUsd: number | null; tokens: unknown }[] };

const runCase = async (testCase: LabCase): Promise<CaseOutcome<Run, never>> => {
  const started = Date.now();
  const request = requestFor(testCase, OS);
  let lab: generator.GeneratedLab | null = null;
  let error: string | null = null;
  let grade: LabRun | null = null;
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
    grade = await runLab(await toLabArtifact(lab, request));
  } catch (caught) {
    const coded = caught as Error & { code?: string };
    error = `${coded.code ?? ''} ${coded.message}`.trim();
  }
  return {
    id: testCase.id,
    seconds: Math.round((Date.now() - started) / 1000),
    agentCostUsd: costUsd,
    judgeCostUsd: 0,
    run: { lab, error, grade, calls },
    checks: check(lab, error, grade),
    scores: null,
  };
};

// The eval's target: the share of cases whose first lab runs.
const suite = (results: CaseOutcome<Run, never>[]) => {
  const runs = results.filter((result) => result.checks.runs?.pass).length;
  return { firstRoundRuns: `${runs}/${results.length}`, firstRoundRunRate: results.length ? Math.round((runs / results.length) * 100) : null };
};

runSuite({ suiteDir: import.meta.dirname, cases, criteria: [], runCase, suite }).catch((error) => {
  console.error(error);
  process.exit(1);
});
