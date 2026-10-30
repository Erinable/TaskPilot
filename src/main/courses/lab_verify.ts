// The lab self-check: before a generated lab reaches a learner, TaskPilot
// runs it the way its repository will, `make grade` in a scratch folder, and
// asks for two reviews (./agents/lab_verifier.ts). Four checks:
//   reference    the solution passes every test: public, hidden and the
//                earlier stages' (regression)
//   starter      it builds, fails every public test of this stage, and
//                passes the earlier stages' tests
//   mutants      of five plausible wrong solutions, public and hidden tests
//                together catch at least 4, public tests alone at least 2
//   consistency  a separate review finds every rule tested, every test
//                stated, and no interface the statement does not give
// A failed round's report goes back to the generator, which rewrites only
// the parts it names (./agents/lab_generator.ts repair); after two retries a
// lab that still fails is marked needs_review.
//
// [人工决策-2026-10-27 00:36:21] lab 只做"仓库 + 测试"：参考解要测试全过才算合格，自验证就是在沙箱里跑仓库的 make grade。
//
// SECURITY: everything run here is code a model wrote. It runs only under
// the Coding Agent's Seatbelt profile (./coding_sandbox.ts) with the network
// denied, an empty environment but for the lab toolchain's variables
// (./lab_toolchain.ts) and a scratch folder as its only writable
// place besides the temporary folders; without Seatbelt the check refuses to
// run rather than run it unsandboxed. The report's details (test names,
// mutants, review issues) stay private; the renderer sees pass/fail and counts.
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { logger } from '../infrastructure/logger.ts';
import { failWith } from '../infrastructure/coded_error.ts';
import * as labs from './labs.ts';
import * as verification from '../checking/verification.ts';
import { SANDBOX_EXEC_PATH } from '../coding/coding_sandbox.ts';
import { sandboxArgs, sandboxAvailable, toolchainMissing } from './lab_toolchain.ts';
import { buildRules } from '../../shared/lab_toolchains.ts';
import { programOfLab } from '../agents/lab_generator.ts';
import type { ToolchainProbe } from './lab_toolchain.ts';
import { ISSUE_PARTS, MUTANT_COUNT } from '../agents/lab_verifier.ts';
import type { ConsistencyIssue, Mutant } from '../agents/lab_verifier.ts';
import type { GeneratedLab, LabPart, SourceFile } from '../agents/lab_generator.ts';
import type * as requirementTypes from '../../shared/ipc/requirements.ts';
import type { LabProgram, LabToolchainId } from '../../shared/lab_toolchains.ts';

// The first round and two retries.
export const MAX_ROUNDS = 3;
const MUTANTS_KILLED = 4;
const PUBLIC_KILLED = 2;
const GRADE_TIMEOUT_MS = 120_000;
const GRADE_PARALLEL = 2;
const OUTPUT_TAIL = 2000;

// One `make grade`: whether it built and finished (make exits 0; test files
// always do), and each test's result by the name it printed.
export type GradeRun = { built: boolean; results: Record<string, boolean>; output: string };
// `toolchain` picks the variables the sandbox gets (null: a lab repository
// from before toolchains, every preset's).
export type Grader = (
  files: Record<string, string>,
  options: { signal?: AbortSignal; envPath?: string | null; toolchain: LabToolchainId | null },
) => Promise<GradeRun>;

// A check's verdict, what it says in the report, and the parts a repair rewrites.
export type CheckResult = { pass: boolean; detail: string[]; parts: LabPart[] };
export type MutantResult = { description: string; built: boolean; killed: boolean; publicKilled: boolean };

// One round as verify.json keeps it: the wire round plus the details.
export type RoundReport = requirementTypes.LabVerifyRound & {
  detail: Record<requirementTypes.LabVerifyCheck, string[]>;
  mutantResults: MutantResult[];
  issueDetails: ConsistencyIssue[];
  parts: LabPart[];
  // Set when the repair after this round was refused by the generator's checks.
  repairError?: string;
  costUsd: number;
};
// verify.json, private: every round and what the check cost.
export type LabVerifyReport = { status: 'passed' | 'needs_review'; rounds: RoundReport[]; costUsd: number; finishedAt: string };

// ========== Running make grade ==========

const writeFiles = async (root: string, files: Record<string, string>) => {
  for (const [file, content] of Object.entries(files)) {
    await fsp.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fsp.writeFile(path.join(root, file), content);
  }
};

const toGradeRun = (result: verification.RunResult): GradeRun => ({
  built: result.exitCode === 0 && !result.timedOut,
  results: Object.fromEntries(result.results.map((entry) => [entry.name, entry.passed])),
  output: result.output.slice(-OUTPUT_TAIL),
});

// Writes `files` into a scratch folder and runs `make grade` there under the
// Seatbelt profile with the network denied, an empty environment but for
// the toolchain's variables (./lab_toolchain.ts) and the scratch folder as
// HOME. Refuses where Seatbelt is not available.
export const sandboxGrader =
  (home = os.homedir()): Grader =>
  async (files, { signal, envPath, toolchain }) => {
    if (!sandboxAvailable()) return failWith('The lab self-check runs generated code only inside the macOS sandbox', 'sandbox_unavailable');
    const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'taskpilot-lab-verify-')));
    try {
      await writeFiles(root, files);
      const args = sandboxArgs({ root, home, envPath, toolchain, command: ['make', 'grade'] });
      const target = { root, commands: { grade: { command: SANDBOX_EXEC_PATH, args } } };
      return toGradeRun(await verification.run(target, 'grade', { signal, timeoutMs: GRADE_TIMEOUT_MS, envPath }));
    } finally {
      await fsp.rm(root, { recursive: true, force: true, maxRetries: 3 });
    }
  };

// ========== The repository a check runs ==========

// The repository a check runs: `base` (the repository so far; the Makefile
// and tests/grade.sh for a first lab), the lab with `code` in place of the
// starter, and tests/build.mk written by TaskPilot for the toolchain and
// every stage's program, this lab's last.
export type Target = { stage: number; base: Record<string, string>; toolchain: LabToolchainId; programs: LabProgram[] };
const repository = (lab: GeneratedLab, target: Target, code: SourceFile[], hidden: boolean) => ({
  ...target.base,
  [`labs/${String(target.stage).padStart(2, '0')}-${lab.id}/README.md`]: lab.readme,
  ...Object.fromEntries(lab.starter.map((file) => [file.path, code.find((entry) => entry.path === file.path)?.content ?? file.content])),
  ...Object.fromEntries(lab.publicTests.map((file) => [`${labs.PUBLIC_TESTS_DIR}/${file.file}`, file.script])),
  ...(hidden ? Object.fromEntries(lab.hiddenTests.map((file) => [`${labs.PUBLIC_TESTS_DIR}/${file.file}`, file.script])) : {}),
  [labs.BUILD_RULES_PATH]: buildRules(target.toolchain, [...target.programs, programOfLab(lab, target.toolchain)]),
});

const namesOf = (files: GeneratedLab['publicTests']) => files.flatMap((file) => file.names);
const quoted = (names: string[]) => names.map((name) => `"${name}"`).join(', ');
const outputLine = (run: GradeRun) => `make grade output (tail):\n${run.output}`;

// ========== The four checks ==========

// Every test the run reports passes (earlier stages' included) and every
// test of this lab is among them. A failing test names the part it is in,
// beside the solution, since either can be wrong.
export const checkReference = (run: GradeRun, lab: Pick<GeneratedLab, 'publicTests' | 'hiddenTests'>): CheckResult => {
  if (!run.built) return { pass: false, detail: ['The solution does not build or `make grade` did not finish.', outputLine(run)], parts: ['solution'] };
  const publicNames = namesOf(lab.publicTests);
  const hiddenNames = namesOf(lab.hiddenTests);
  const missing = [...publicNames, ...hiddenNames].filter((name) => !(name in run.results));
  const failed = Object.keys(run.results).filter((name) => !run.results[name]);
  if (!missing.length && !failed.length) return { pass: true, detail: [], parts: [] };
  const parts: LabPart[] = ['solution'];
  if (failed.some((name) => publicNames.includes(name)) || missing.some((name) => publicNames.includes(name))) parts.push('publicTests');
  if (failed.some((name) => hiddenNames.includes(name)) || missing.some((name) => hiddenNames.includes(name))) parts.push('hiddenTests');
  return {
    pass: false,
    detail: [
      ...(failed.length ? [`With the solution these tests fail: ${quoted(failed)}.`] : []),
      ...(missing.length ? [`These tests never report a result: ${quoted(missing)}.`] : []),
    ],
    parts,
  };
};

// The starter builds; this stage's public tests all fail; every other test
// the run reports (the earlier stages') passes.
export const checkStarter = (run: GradeRun, lab: Pick<GeneratedLab, 'publicTests'>): CheckResult => {
  if (!run.built) return { pass: false, detail: ['The starter code does not build or `make grade` did not finish.', outputLine(run)], parts: ['starter'] };
  const stageNames = namesOf(lab.publicTests);
  const passing = stageNames.filter((name) => run.results[name] === true);
  const missing = stageNames.filter((name) => !(name in run.results));
  const regressions = Object.keys(run.results).filter((name) => !stageNames.includes(name) && !run.results[name]);
  if (!passing.length && !missing.length && !regressions.length) return { pass: true, detail: [], parts: [] };
  return {
    pass: false,
    detail: [
      ...(passing.length ? [`The starter code already passes: ${quoted(passing)}. Stub the TODOs with values no test accepts.`] : []),
      ...(missing.length ? [`With the starter code these tests never report a result: ${quoted(missing)}.`] : []),
      ...(regressions.length ? [`The starter code breaks earlier stages' tests: ${quoted(regressions)}.`] : []),
    ],
    parts: ['starter'],
  };
};

// A mutant is killed when one of its tests fails. One that does not build
// or finish measures nothing (the generator was told mutants must build),
// so it counts as not killed: a broken mutant must never pass the check.
// Test files are independent, so the public tests' verdict (this stage's
// and the earlier ones') is read from the same run: any failure outside
// the hidden tests.
export const mutantResult = (mutant: Pick<Mutant, 'description'>, run: GradeRun, hiddenNames: string[]): MutantResult => {
  const failed = Object.keys(run.results).filter((name) => !run.results[name]);
  return {
    description: mutant.description,
    built: run.built,
    killed: run.built && failed.length > 0,
    publicKilled: run.built && failed.some((name) => !hiddenNames.includes(name)),
  };
};

export const checkMutants = (results: MutantResult[]): CheckResult => {
  const killed = results.filter((result) => result.killed).length;
  const publicKilled = results.filter((result) => result.publicKilled).length;
  const survivors = results.filter((result) => !result.killed);
  const pass = killed >= MUTANTS_KILLED && publicKilled >= PUBLIC_KILLED;
  const parts: LabPart[] = [...(survivors.length ? ['hiddenTests' as const] : []), ...(publicKilled < PUBLIC_KILLED ? ['publicTests' as const] : [])];
  return {
    pass,
    detail: [
      `${killed} of ${results.length} wrong solutions are caught by the tests (at least ${MUTANTS_KILLED} must be), ${publicKilled} by the public tests alone (at least ${PUBLIC_KILLED} must be).`,
      ...survivors.map((result) =>
        result.built ? `Not caught: ${result.description}` : `Does not build or finish, so it measures nothing: ${result.description}`,
      ),
      ...results.filter((result) => result.killed && !result.publicKilled).map((result) => `Only a hidden test catches: ${result.description}`),
    ],
    parts,
  };
};

export const checkConsistency = (issues: ConsistencyIssue[]): CheckResult => ({
  pass: issues.length === 0,
  detail: issues.map((issue) => `${issue.kind}: ${issue.detail}`),
  parts: [...new Set(issues.flatMap((issue) => ISSUE_PARTS[issue.kind]))],
});

// ========== Rounds ==========

export type VerifyProgress = (state: { round: number; phase: 'verify' | 'repair'; rounds: RoundReport[] }) => Promise<void>;

export type VerifyDeps = {
  grade: Grader;
  // Checked before every round: a toolchain missing under the sandbox
  // stops the check (toolchain_missing) instead of failing the lab.
  probe: ToolchainProbe;
  envPath?: string | null;
  signal?: AbortSignal;
  writeMutants: (lab: GeneratedLab) => Promise<{ mutants: Mutant[]; costUsd: number }>;
  judge: (lab: GeneratedLab) => Promise<{ issues: ConsistencyIssue[]; costUsd: number }>;
  repair: (lab: GeneratedLab, failure: { report: string; parts: LabPart[] }) => Promise<{ lab: GeneratedLab; costUsd: number }>;
  onProgress?: VerifyProgress;
};

const cancelled = (signal?: AbortSignal) => {
  if (signal?.aborted) throw Object.assign(new Error('Agent run was cancelled'), { code: 'agent_cancelled' });
};

// Each mutant over the solution, graded with every test, two at a time so
// five compilers do not start at once.
const gradeMutants = async (lab: GeneratedLab, target: Target, mutants: Mutant[], deps: VerifyDeps) => {
  const solved = lab.starter.map((file) => lab.solution.find((entry) => entry.path === file.path) ?? file);
  const hiddenNames = namesOf(lab.hiddenTests);
  const results: MutantResult[] = [];
  for (let index = 0; index < mutants.length; index += GRADE_PARALLEL) {
    const batch = mutants.slice(index, index + GRADE_PARALLEL).map(async (mutant) => {
      const code = solved.map((file) => mutant.files.find((entry) => entry.path === file.path) ?? file);
      const run = await deps.grade(repository(lab, target, code, true), { signal: deps.signal, envPath: deps.envPath, toolchain: target.toolchain });
      return mutantResult(mutant, run, hiddenNames);
    });
    results.push(...(await Promise.all(batch)));
    cancelled(deps.signal);
  }
  return results;
};

// One round: the two local runs, then the two reviews side by side. The
// mutants are skipped while the solution itself fails, since mutating a
// wrong solution measures nothing.
const runRound = async (lab: GeneratedLab, target: Target, deps: VerifyDeps, round: number) => {
  const options = { signal: deps.signal, envPath: deps.envPath, toolchain: target.toolchain };
  const reference = checkReference(await deps.grade(repository(lab, target, lab.solution, true), options), lab);
  cancelled(deps.signal);
  const starter = checkStarter(await deps.grade(repository(lab, target, lab.starter, false), options), lab);
  cancelled(deps.signal);
  const [mutantRun, judged] = await Promise.all([
    reference.pass ? deps.writeMutants(lab).then(async ({ mutants, costUsd }) => ({ results: await gradeMutants(lab, target, mutants, deps), costUsd })) : null,
    deps.judge(lab),
  ]);
  const mutants = mutantRun ? checkMutants(mutantRun.results) : null;
  const consistency = checkConsistency(judged.issues);
  const checks = { reference, starter, mutants, consistency };
  const failing = Object.values(checks).filter((check): check is CheckResult => check !== null && !check.pass);
  // A failed round also asks the repair to catch any mutant that got
  // through, even when enough others were caught.
  const parts = failing.length ? [...new Set([...failing, ...(mutants ? [mutants] : [])].flatMap((check) => check.parts))] : [];
  const report: RoundReport = {
    round,
    checks: { reference: reference.pass, starter: starter.pass, mutants: mutants?.pass ?? null, consistency: consistency.pass },
    mutants: mutantRun && {
      killed: mutantRun.results.filter((result) => result.killed).length,
      publicKilled: mutantRun.results.filter((result) => result.publicKilled).length,
      total: MUTANT_COUNT,
    },
    issues: judged.issues.length,
    repaired: false,
    detail: {
      reference: reference.detail,
      starter: starter.detail,
      mutants: mutants?.detail ?? ['Skipped: the solution does not pass its own tests yet.'],
      consistency: consistency.detail,
    },
    mutantResults: mutantRun?.results ?? [],
    issueDetails: judged.issues,
    parts,
    costUsd: (mutantRun?.costUsd ?? 0) + judged.costUsd,
  };
  return { pass: failing.length === 0, report };
};

// The failure report the generator reads: each check's own words.
const surviving = (report: RoundReport) => report.mutantResults.some((result) => !result.killed);
const failureReport = (report: RoundReport): string =>
  (['reference', 'starter', 'mutants', 'consistency'] as const)
    .filter((check) => report.checks[check] === false || (check === 'mutants' && surviving(report)))
    .map((check) => [`## ${check}`, ...report.detail[check]].join('\n'))
    .join('\n\n');

// Runs rounds until one passes or three have run, repairing between them.
// Returns the lab as it stands after the last repair, and the report.
// `programs` are the earlier stages' programs, built beside this lab's.
export const verifyLab = async (lab: GeneratedLab, target: Target, deps: VerifyDeps): Promise<{ lab: GeneratedLab; report: LabVerifyReport }> => {
  const rounds: RoundReport[] = [];
  let current = lab;
  let costUsd = 0;
  for (let round = 1; ; round += 1) {
    cancelled(deps.signal);
    await deps.onProgress?.({ round, phase: 'verify', rounds });
    const check = await deps.probe(target.toolchain, { envPath: deps.envPath, signal: deps.signal });
    if (!check.ready) throw toolchainMissing(check);
    const { pass, report } = await runRound(current, target, deps, round);
    rounds.push(report);
    costUsd += report.costUsd;
    logger.debug(`[lab-verify] round=${round} checks=${JSON.stringify(report.checks)} parts=${report.parts.join(',')}`);
    if (pass || round === MAX_ROUNDS) {
      const status = pass ? 'passed' : 'needs_review';
      return { lab: current, report: { status, rounds, costUsd, finishedAt: new Date().toISOString() } };
    }
    await deps.onProgress?.({ round, phase: 'repair', rounds });
    let repaired: { lab: GeneratedLab; costUsd: number };
    try {
      repaired = await deps.repair(current, { report: failureReport(report), parts: report.parts });
    } catch (error) {
      // A repair the generator's checks refuse leaves nothing new to check;
      // the lab is as reviewable as one that kept failing.
      if ((error as { code?: string }).code !== 'agent_bad_output') throw error;
      logger.error(error);
      report.repairError = (error as Error).message;
      return { lab: current, report: { status: 'needs_review', rounds, costUsd, finishedAt: new Date().toISOString() } };
    }
    report.repaired = true;
    report.costUsd += repaired.costUsd;
    costUsd += repaired.costUsd;
    current = repaired.lab;
  }
};

// What the renderer sees of a round: verdicts and counts, never details.
export const wireRound = (report: RoundReport): requirementTypes.LabVerifyRound => ({
  round: report.round,
  checks: report.checks,
  mutants: report.mutants,
  issues: report.issues,
  repaired: report.repaired,
});

// A first lab's repository before the lab: TaskPilot's own scaffolding.
export const FIRST_STAGE_BASE: Record<string, string> = { Makefile: labs.MAKEFILE, [labs.GRADE_SCRIPT_PATH]: labs.GRADE_SCRIPT };
