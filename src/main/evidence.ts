// Turns verification runs into evidence QA can act on.
//
// Every check yields one of four statuses:
//   pass          the check ran and this package broke nothing it measures
//   fail          the package made something worse, or we cannot tell and the
//                 conservative answer is "worse" (no baseline to compare with)
//   unverifiable  the check could not say either way: it was already broken at
//                 the baseline in the same way, or its report could not be read
//                 without a failure to attribute
//   skipped       not configured to run at this stage
//
// A baseline is the same check run on the claimed commit with a clean tree.
// Tests failing there already are "preexisting" and do not count against the
// package; tests failing only now are "newFailures".
//
// Everything here is pure, so the rules can be tested row by row.
import type { CheckRun, TestResult } from './verification.ts';
import type { CheckKind, CheckStage } from './workspace.ts';
import type { AcceptanceCriterion } from './tasks.ts';

export type EvidenceStatus = 'pass' | 'fail' | 'unverifiable' | 'skipped';

// A check run measured at the baseline (baselineRecord()).
export interface BaselineRecord {
  status: 'measured';
  line: string;
  exitCode: number;
  timedOut: boolean;
  crashed: boolean;
  reportProblem: string | null;
  failing: string[];
  passing: string[];
  at: string;
}

// A check that could not be measured at the baseline.
export interface UnavailableBaselineRecord {
  status: 'unavailable';
  reason: string;
  line: string;
}

// One entry of a package's baseline checks, keyed by check kind.
export type BaselineCheck = BaselineRecord | UnavailableBaselineRecord;

// The check evaluate() reports on.
export interface EvidenceCheck {
  kind: CheckKind;
  stage: CheckStage;
  blocking: boolean;
}

// A check that could not start.
export interface RunFailure {
  error: { code?: string; message?: string };
}

// What a check produced: a runCheck() result or why it did not run.
export type CheckOutcome = CheckRun | RunFailure;

// The parts of a run evidence reads.
type RunLike = Pick<CheckRun, 'results' | 'exitCode' | 'timedOut'> & { report?: CheckRun['report'] | null; error?: undefined };

// Evidence for one check.
export interface EvidenceItem {
  kind: CheckKind;
  stage: CheckStage;
  blocking: boolean;
  baseline: 'measured' | 'none';
  status: EvidenceStatus;
  reason: string | null;
  newFailures: string[];
  preexisting: string[];
  fixed: string[];
}

export type CriterionStatus = 'verified' | 'failed' | 'missing' | 'unverifiable' | 'manual';

// An acceptance criterion with its status from the submit-stage runs.
export type CriterionResult = AcceptanceCriterion & {
  status: CriterionStatus;
  verified: boolean;
  manual: boolean;
  missing?: boolean;
  alreadyPassing?: boolean;
};

// Why a human must look at a package QA passed.
export type AttentionItem =
  | { code: 'check_unverifiable'; kind: CheckKind; reason: string | null; blocking: boolean }
  | { code: 'preexisting_failures'; kind: CheckKind; count: number }
  | { code: 'no_baseline'; kind: CheckKind }
  | { code: 'criterion_unverifiable' | 'criterion_manual' | 'criterion_already_passing'; index: number };

export const MAX_BASELINE_FAILING = 5000;
export const MAX_BASELINE_PASSING = 5000;
export const MAX_LISTED = 50;

const counted = (results: TestResult[]) => results.filter((r) => !r.skipped && !r.todo);
const keyOf = (r: TestResult) => r.fullName ?? r.name;
const failingNames = (results: TestResult[]) =>
  counted(results)
    .filter((r) => !r.passed)
    .map(keyOf);
const passingNames = (results: TestResult[]) =>
  counted(results)
    .filter((r) => r.passed)
    .map(keyOf);

// What is stored for a check run at the baseline.
export const baselineRecord = (run: RunLike, line: string, at = new Date().toISOString()): BaselineRecord => {
  const failing = failingNames(run.results);
  const untrusted = Boolean(run.report && !run.report.trusted);
  return {
    status: 'measured',
    line,
    exitCode: run.exitCode,
    timedOut: run.timedOut,
    // Non-zero exit with no failing test to blame: the runner itself broke.
    crashed: !run.timedOut && run.exitCode !== 0 && (failing.length === 0 || untrusted),
    reportProblem: untrusted ? (run.report?.problem ?? null) : null,
    failing: failing.slice(0, MAX_BASELINE_FAILING),
    passing: passingNames(run.results).slice(0, MAX_BASELINE_PASSING),
    at,
  };
};

// A baseline is usable only if it was measured for the same command line.
export const usableBaseline = (baseline: BaselineCheck | null | undefined, line: string): BaselineRecord | null =>
  baseline?.status === 'measured' && baseline.line === line ? baseline : null;

// Evidence for one check.
// check: {kind, stage, blocking}
// run: runCheck() result, or {error: {code, message}} when it could not start
// baseline: usableBaseline() result or null
export const evaluate = (check: EvidenceCheck, outcome: RunLike | RunFailure, baseline: BaselineRecord | null): EvidenceItem => {
  const base: Omit<EvidenceItem, 'status' | 'reason'> = {
    kind: check.kind,
    stage: check.stage,
    blocking: check.blocking,
    baseline: baseline ? 'measured' : 'none',
    newFailures: [],
    preexisting: [],
    fixed: [],
  };
  const done = (status: EvidenceStatus, reason: string | null, extra = {}): EvidenceItem => ({ ...base, status, reason, ...extra });

  if (outcome.error) return done('unverifiable', outcome.error.code ?? 'not_run');
  const run = outcome as RunLike;

  const failing = failingNames(run.results);
  const untrusted = Boolean(run.report && !run.report.trusted);
  const crashed = !run.timedOut && run.exitCode !== 0 && (failing.length === 0 || untrusted);

  if (run.timedOut) {
    return baseline?.timedOut ? done('unverifiable', 'timed_out_at_baseline') : done('fail', 'timed_out');
  }

  if (untrusted) {
    // A clean exit with an unreadable report proves nothing either way; a
    // failing exit is a failure we cannot narrow down.
    if (run.exitCode === 0) return done('unverifiable', `report_${run.report?.problem}`);
    if (baseline?.crashed) return done('unverifiable', 'broken_at_baseline');
    return done('fail', `report_${run.report?.problem}`);
  }

  if (crashed) {
    if (baseline?.crashed && baseline.exitCode === run.exitCode) return done('unverifiable', 'broken_at_baseline');
    return done('fail', 'crashed');
  }

  const before = new Set(baseline?.failing ?? []);
  const now = new Set(failing);
  const newFailures = baseline ? failing.filter((name) => !before.has(name)) : failing;
  const preexisting = baseline ? failing.filter((name) => before.has(name)) : [];
  const passing = new Set(passingNames(run.results));
  const fixed = baseline ? [...before].filter((name) => !now.has(name) && passing.has(name)) : [];
  const lists = { newFailures: newFailures.slice(0, MAX_LISTED), preexisting: preexisting.slice(0, MAX_LISTED), fixed: fixed.slice(0, MAX_LISTED) };

  if (run.exitCode === 0 && failing.length === 0) return done('pass', null, lists);
  if (newFailures.length > 0) return done('fail', baseline ? 'new_failures' : 'no_baseline', lists);
  // Only tests that were already failing still fail.
  return done('pass', 'preexisting_only', lists);
};

// Status of each acceptance criterion from the submit-stage runs.
//   verified | failed | missing | unverifiable | manual
// `alreadyPassing` marks a linked test that passed at the baseline too, so
// it does not show the package did anything (red-first hint, never blocking).
// The legacy {verified, manual, missing} fields are kept for the UI.
export const criteriaStatus = (
  criteria: AcceptanceCriterion[],
  runs: Partial<Record<string, RunLike | RunFailure>>,
  evidence: Pick<EvidenceItem, 'kind' | 'status'>[],
  baselines: Partial<Record<string, BaselineCheck | null>> = {},
): CriterionResult[] => {
  const trusted: { kind: string; results: TestResult[] }[] = [];
  let anyUntrusted = false;
  for (const [kind, outcome] of Object.entries(runs)) {
    if (!outcome) continue;
    const item = evidence.find((e) => e.kind === kind);
    if (outcome.error) {
      anyUntrusted = true;
      continue;
    }
    const run = outcome as RunLike;
    if (run.timedOut || (run.report && !run.report.trusted) || item?.status === 'unverifiable') anyUntrusted = true;
    if (!run.report || run.report.trusted) trusted.push({ kind, results: run.results });
  }
  return criteria.map((criterion) => {
    if (!criterion.test) return { ...criterion, status: 'manual', verified: false, manual: true };
    let found: TestResult | null = null;
    let foundIn: string | null = null;
    for (const { kind, results } of trusted) {
      found = results.find((r) => r.name === criterion.test || keyOf(r) === criterion.test) ?? null;
      if (found) {
        foundIn = kind;
        break;
      }
    }
    const status = found ? (found.passed ? 'verified' : 'failed') : anyUntrusted ? 'unverifiable' : 'missing';
    const baselineAt = foundIn ? baselines[foundIn] : null;
    const passedBefore = Boolean(found && baselineAt && 'passing' in baselineAt && (baselineAt.passing ?? []).includes(keyOf(found)));
    return {
      ...criterion,
      status,
      verified: status === 'verified',
      manual: false,
      missing: status === 'missing',
      alreadyPassing: Boolean(found?.passed && passedBefore),
    };
  });
};

// Why a human must look even though nothing rejected the package.
export const attention = (evidence: EvidenceItem[], criteria: Pick<CriterionResult, 'status' | 'alreadyPassing'>[]): AttentionItem[] => {
  const items: AttentionItem[] = [];
  for (const e of evidence) {
    if (e.status === 'unverifiable') items.push({ code: 'check_unverifiable', kind: e.kind, reason: e.reason, blocking: e.blocking });
    if (e.preexisting.length) items.push({ code: 'preexisting_failures', kind: e.kind, count: e.preexisting.length });
    if (e.baseline === 'none' && e.status !== 'skipped') items.push({ code: 'no_baseline', kind: e.kind });
  }
  criteria.forEach((c, index) => {
    if (c.status === 'unverifiable') items.push({ code: 'criterion_unverifiable', index });
    if (c.status === 'manual') items.push({ code: 'criterion_manual', index });
    if (c.alreadyPassing) items.push({ code: 'criterion_already_passing', index });
  });
  return items;
};
