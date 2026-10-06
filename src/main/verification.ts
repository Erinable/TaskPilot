// Runs the workspace's configured verification commands and turns their output
// into structured results the execution page can show.
//
// SECURITY: the command comes from the workspace config only (see
// ./workspace.js), runs through execFile with an argument array, and never
// touches a shell.
import { execFile, type ChildProcess, type ExecFileException, type ExecFileOptions } from 'node:child_process';

import { processEnv } from './env.ts';
import * as testReport from './test_report.ts';
import type { Check, CheckStage, CommandEntry } from './workspace.ts';
import type { AcceptanceCriterion } from './tasks.ts';

export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_BUFFER = 20 * 1024 * 1024;

// One test result; `fullName` (suites joined) is the key baselines use.
export interface TestResult {
  name: string;
  fullName?: string;
  passed: boolean;
  skipped: boolean;
  todo: boolean;
}

export interface RunSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  ok: boolean;
}

// What execute() reports for one command, before its output is parsed.
export interface CommandOutcome {
  kind: string;
  command: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  output: string;
}

// run() result.
export interface RunResult extends CommandOutcome {
  results: TestResult[];
  summary: RunSummary;
}

export interface ReportInfo {
  format: 'stdout' | 'junit';
  trusted: boolean;
  problem: testReport.ReportProblem | null;
}

// runCheck() result.
export interface CheckRun extends RunResult {
  report: ReportInfo;
  check: { stage: CheckStage; blocking: boolean };
}

// The part of a workspace config run()/runCheck() read; run() also accepts
// ad hoc commands (environment setup steps) under any kind.
export interface VerificationTarget {
  root: string | null;
  checks?: Partial<Record<string, Check | null>>;
  commands?: Partial<Record<string, CommandEntry | null>>;
}

export interface RunOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  envPath?: string | null;
}

// A criterion paired with its test result by matchAcceptance().
export type MatchedCriterion = AcceptanceCriterion & { verified: boolean; manual: boolean; missing?: boolean };

export type VerificationErrorCode = 'command_missing' | 'not_configured' | 'no_workspace';

export class VerificationError extends Error {
  code: VerificationErrorCode;

  constructor(message: string, code: VerificationErrorCode) {
    super(message);
    this.name = 'VerificationError';
    this.code = code;
  }
}

// Parses TAP 13/14 result lines, which is what `node --test` emits.
// Subtests are indented; only top-level lines are collected so a suite does
// not double-count. Returns [] for output that isn't TAP.
export const parseTap = (output: string): TestResult[] => {
  const results: TestResult[] = [];
  for (const line of output.split('\n')) {
    if (/^\s/.test(line)) continue; // subtest
    const match = /^(not ok|ok)\s+(\d+)\s*-?\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, verdict, , rest] = match;
    const name = rest.replace(/\s+#\s*(SKIP|TODO).*$/i, '').trim();
    const directive = /#\s*SKIP/i.test(rest) ? 'skip' : /#\s*TODO/i.test(rest) ? 'todo' : null;
    results.push({
      name,
      passed: verdict === 'ok',
      skipped: directive === 'skip',
      todo: directive === 'todo',
    });
  }
  return results;
};

// Node 22 switched `node --test` from TAP to its "spec" reporter, which marks
// results with ✔/✖ and indents nested tests. Many other runners (vitest, jest)
// print a similar shape, so this covers the common default case too.
const SPEC_LINE = /^(?<mark>[✔✖✗×])\s+(?<name>.+?)(?:\s+\((?<ms>[\d.]+)ms\))?\s*$/;

export const parseSpec = (output: string): TestResult[] => {
  const results: TestResult[] = [];
  for (const line of output.split('\n')) {
    if (/^\s/.test(line)) continue; // nested test
    const match = SPEC_LINE.exec(line.trim() === line ? line : line);
    if (!match) continue;
    // Both groups are mandatory in SPEC_LINE.
    const groups = match.groups as { mark: string; name: string };
    const name = groups.name.trim();
    // The spec reporter repeats failures in a trailing summary block; those
    // lines have no duration, so skip a name already recorded.
    if (results.some((r) => r.name === name)) continue;
    results.push({ name, passed: groups.mark === '✔', skipped: false, todo: false });
  }
  return results;
};

// Picks the parser that matches the output, preferring TAP when both appear.
export const parseResults = (output: string): TestResult[] => {
  const tap = parseTap(output);
  return tap.length > 0 ? tap : parseSpec(output);
};

export const summarize = (results: Pick<TestResult, 'passed' | 'skipped' | 'todo'>[], exitCode: number): RunSummary => {
  const counted = results.filter((r) => !r.skipped && !r.todo);
  return {
    total: counted.length,
    passed: counted.filter((r) => r.passed).length,
    failed: counted.filter((r) => !r.passed).length,
    skipped: results.length - counted.length,
    // Exit code is the source of truth: a runner can fail to start and emit
    // no TAP at all, which must not read as "nothing failed".
    ok: exitCode === 0,
  };
};

interface Spawned {
  error: ExecFileException | null;
  stdout: string;
  stderr: string;
}

const spawn = (command: string, args: string[], options: ExecFileOptions & { onSpawn?: (child: ChildProcess) => void }) =>
  new Promise<Spawned>((resolve) => {
    const child = execFile(command, args, { ...options, encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({ error, stdout, stderr });
    });
    options.onSpawn?.(child);
  });

// Runs {command, args} in the workspace; shared by run() and runCheck().
const execute = async (
  root: string,
  entry: CommandEntry,
  kind: string,
  { signal, timeoutMs, envPath, env = {} }: RunOptions & { env?: Record<string, string> },
): Promise<CommandOutcome> => {
  const startedAt = Date.now();
  const { error, stdout, stderr } = await spawn(entry.command, entry.args, {
    cwd: root,
    maxBuffer: MAX_BUFFER,
    timeout: timeoutMs,
    signal,
    // A test runner that inherits a TTY may emit colour codes; ask it not to.
    // envPath (from ./shell_env.js) overrides the inherited PATH, which is
    // minimal when the app is launched from Finder rather than a terminal.
    // `env` is the check's own variables, validated in workspace.js.
    env: { ...processEnv(), ...env, ...(envPath ? { PATH: envPath } : {}), NO_COLOR: '1', FORCE_COLOR: '0' },
  });

  if (error?.code === 'ENOENT') {
    throw new VerificationError(`Executable not found: ${entry.command}`, 'command_missing');
  }
  if (error?.name === 'AbortError') throw error;

  const output = `${stdout}${stderr}`;
  const timedOut = error?.killed === true && error?.signal === 'SIGTERM';
  // execFile reports a non-zero exit through error.code (a number).
  const exitCode = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
  return {
    kind,
    command: `${entry.command} ${entry.args.join(' ')}`.trim(),
    exitCode,
    timedOut,
    durationMs: Date.now() - startedAt,
    output,
  };
};

// A configured check, or a bare command which then has none of the check fields.
const requireEntry = (config: VerificationTarget, kind: string): { root: string; entry: CommandEntry & Partial<Check> } => {
  const entry = config.checks?.[kind] ?? config.commands?.[kind];
  if (!entry) throw new VerificationError(`No ${kind} command is configured`, 'not_configured');
  if (!config.root) throw new VerificationError('No workspace root is configured', 'no_workspace');
  return { root: config.root, entry };
};

// Executes one verification command and parses its stdout.
export const run = async (
  config: VerificationTarget,
  kind: string,
  { signal, timeoutMs = DEFAULT_TIMEOUT_MS, envPath }: RunOptions = {},
): Promise<RunResult> => {
  const { root, entry } = requireEntry(config, kind);
  const outcome = await execute(root, entry, kind, { signal, timeoutMs, envPath, env: entry.env });
  const results = parseResults(outcome.output);
  return { ...outcome, results, summary: summarize(results, outcome.exitCode) };
};

// Executes a configured check and reads its results from the report it is
// configured with. Results always carry `fullName`, the key baselines use.
// Returns run() result plus `report: {format, trusted, problem}`; for an
// untrusted JUnit report `results` is empty.
export const runCheck = async (config: VerificationTarget, kind: string, { signal, timeoutMs, envPath }: RunOptions = {}): Promise<CheckRun> => {
  const { root, entry: check } = requireEntry(config, kind);
  const report = check.report ?? { format: 'stdout' };
  const before = report.format === 'junit' ? await testReport.statReport(root, report.path) : null;
  const outcome = await execute(root, check, kind, {
    signal,
    timeoutMs: timeoutMs ?? check.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    envPath,
    env: check.env,
  });
  let results: TestResult[];
  let reportInfo: ReportInfo;
  if (report.format === 'junit') {
    const read = await testReport.readReport(root, report, before);
    results = read.results;
    reportInfo = { format: 'junit', trusted: read.trusted, problem: read.problem };
  } else {
    results = parseResults(outcome.output).map((r) => ({ ...r, fullName: r.fullName ?? r.name }));
    reportInfo = { format: 'stdout', trusted: true, problem: null };
  }
  return {
    ...outcome,
    results,
    summary: summarize(results, outcome.exitCode),
    report: reportInfo,
    check: { stage: check.stage as CheckStage, blocking: check.blocking as boolean },
  };
};

// Pairs acceptance criteria with test results. A criterion carrying a `test`
// name is satisfied only when a matching test passed; one without stays
// manual, so a package can never auto-accept on criteria nobody checked.
export const matchAcceptance = (criteria: AcceptanceCriterion[], results: Pick<TestResult, 'name' | 'fullName' | 'passed'>[]): MatchedCriterion[] => {
  const byName = new Map<string, Pick<TestResult, 'name' | 'fullName' | 'passed'>>();
  for (const r of results) {
    if (!byName.has(r.name)) byName.set(r.name, r);
    if (r.fullName) byName.set(r.fullName, r);
  }
  return criteria.map((criterion) => {
    if (!criterion.test) return { ...criterion, verified: false, manual: true };
    const result = byName.get(criterion.test);
    return {
      ...criterion,
      verified: result?.passed === true,
      manual: false,
      missing: result === undefined,
    };
  });
};
