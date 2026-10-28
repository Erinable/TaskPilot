// Runs check steps and turns their output into structured results the
// execution page can show.
//
// SECURITY: commands come from the effective steps only (see
// ./effective_steps.ts), run through execFile with an argument array, and
// never touch a shell.
import path from 'node:path';
import { execFile, type ChildProcess, type ExecFileException, type ExecFileOptions } from 'node:child_process';

import { processEnv } from '../infrastructure/env.ts';
import * as testReport from './test_report.ts';
import * as checkOutput from './check_output.ts';
import { formatCommandLine } from './command_line.ts';
import type { CommandEntry } from './command_line.ts';
import type { CheckStage, CheckStep } from './step_config.ts';
import type { TestResult } from './check_output.ts';
import type { Diagnostic } from '../../shared/check_steps.ts';
import type { AcceptanceCriterion } from '../work_packages/tasks.ts';

export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_BUFFER = 20 * 1024 * 1024;

export interface RunSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  ok: boolean;
}

// What execute() reports for one command, before its output is parsed.
// `output` is stdout and stderr together.
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

// Whether the step's output could be read in its configured format.
// `format` is the step's parser format.
export interface ReportInfo {
  format: string;
  trusted: boolean;
  problem: testReport.ReportProblem | null;
}

// runStep() result. `kind` is the step id.
export interface CheckRun extends RunResult {
  report: ReportInfo;
  diagnostics: Diagnostic[];
  check: { stage: CheckStage; blocking: boolean };
}

// What run() executes: ad hoc commands (environment setup) under any kind.
export interface VerificationTarget {
  root: string | null;
  commands?: Partial<Record<string, CommandEntry | null>>;
}

export interface RunOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  envPath?: string | null;
  // Receives output as it arrives, for a live view of a long command.
  onOutput?: (chunk: string) => void;
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
    // Checks are never interactive. Without an end of input, a command that
    // reads stdin (a prompt, a watch mode, `cat`) would wait forever.
    child.stdin?.end();
    options.onSpawn?.(child);
  });

// Runs {command, args} in `root`; shared by run() and runStep().
const execute = async (
  root: string,
  entry: CommandEntry,
  kind: string,
  { signal, timeoutMs, envPath, onOutput, env = {} }: RunOptions & { env?: Record<string, string> },
): Promise<CommandOutcome & { stdout: string }> => {
  const startedAt = Date.now();
  const { error, stdout, stderr } = await spawn(entry.command, entry.args, {
    onSpawn: onOutput
      ? (child) => {
          child.stdout?.on('data', (chunk) => onOutput(String(chunk)));
          child.stderr?.on('data', (chunk) => onOutput(String(chunk)));
        }
      : undefined,
    cwd: root,
    maxBuffer: MAX_BUFFER,
    timeout: timeoutMs,
    signal,
    // A test runner that inherits a TTY may emit colour codes; ask it not to.
    // Cargo lets an inherited CARGO_TERM_COLOR=always beat NO_COLOR, which
    // breaks parsing its `Running` lines, so that one is set as well.
    // envPath (from ./shell_env.js) overrides the inherited PATH, which is
    // minimal when the app is launched from Finder rather than a terminal.
    // `env` is the check's own variables, validated in workspace.js.
    env: { ...processEnv(), ...env, ...(envPath ? { PATH: envPath } : {}), NO_COLOR: '1', FORCE_COLOR: '0', CARGO_TERM_COLOR: 'never' },
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
    stdout,
  };
};

// Executes one ad hoc command (an environment setup step) and parses its
// output as tests.
export const run = async (
  config: VerificationTarget,
  kind: string,
  { signal, timeoutMs = DEFAULT_TIMEOUT_MS, envPath, onOutput }: RunOptions = {},
): Promise<RunResult> => {
  const entry = config.commands?.[kind];
  if (!entry) throw new VerificationError(`No ${kind} command is configured`, 'not_configured');
  if (!config.root) throw new VerificationError('No workspace root is configured', 'no_workspace');
  const { stdout: _stdout, ...outcome } = await execute(config.root, entry, kind, { signal, timeoutMs, envPath, onOutput });
  const results = checkOutput.parseResults(outcome.output);
  return { ...outcome, results, summary: summarize(results, outcome.exitCode) };
};

// The step's commands in order, stopping at the first that fails. The
// outcome is the last one run, with every command's output joined.
const executeAll = async (cwd: string, step: CheckStep, options: RunOptions & { env: Record<string, string> }) => {
  const outputs: string[] = [];
  const stdouts: string[] = [];
  let last: (CommandOutcome & { stdout: string }) | null = null;
  let durationMs = 0;
  for (const entry of step.commands) {
    last = await execute(cwd, entry, step.id, options);
    durationMs += last.durationMs;
    outputs.push(step.commands.length > 1 ? `$ ${formatCommandLine(entry)}\n${last.output}` : last.output);
    stdouts.push(last.stdout);
    if (last.exitCode !== 0 || last.timedOut) break;
  }
  // A step has at least one command (step_config.ts).
  const { stdout: _stdout, ...outcome } = last as CommandOutcome & { stdout: string };
  return {
    outcome: { ...outcome, command: step.commands.map(formatCommandLine).join(' && '), durationMs, output: outputs.join('\n') },
    stdout: stdouts.join('\n'),
  };
};

// Executes a check step and reads its results the way its parser says.
// Results always carry `fullName`, the key baselines use; error
// diagnostics are results too. For an unreadable report `results` is empty
// and `report.trusted` is false.
export const runStep = async (root: string | null, step: CheckStep, { signal, timeoutMs, envPath }: RunOptions = {}): Promise<CheckRun> => {
  if (!root) throw new VerificationError('No workspace root is configured', 'no_workspace');
  const cwd = path.join(root, step.cwd);
  const parser = step.parser;
  const reportPath = 'path' in parser && parser.path ? path.join(step.cwd, parser.path) : null;
  const before = reportPath ? await testReport.statReport(root, reportPath) : null;
  const { outcome, stdout } = await executeAll(cwd, step, { signal, timeoutMs: timeoutMs ?? step.timeoutMs ?? DEFAULT_TIMEOUT_MS, envPath, env: step.env });
  let parsed: checkOutput.ParsedOutput | null = null;
  let problem: testReport.ReportProblem | null = null;
  if (parser.format === 'junit') {
    const read = await testReport.readReport(root, { path: reportPath as string }, before);
    problem = read.problem;
    parsed = read.trusted ? checkOutput.fromTests(read.results) : null;
  } else {
    let content = stdout;
    if (reportPath) {
      const read = await testReport.readReportFile(root, reportPath, before);
      if (read.problem) problem = read.problem;
      else content = read.content;
    }
    if (!problem) {
      parsed = checkOutput.parseOutput(parser, { output: outcome.output, content, root, cwd: step.cwd });
      if (!parsed) problem = 'invalid';
    }
  }
  const results = (parsed?.results ?? []).map((result) => ({ ...result, fullName: result.fullName ?? result.name }));
  return {
    ...outcome,
    results,
    diagnostics: parsed?.diagnostics ?? [],
    summary: summarize(results, outcome.exitCode),
    report: { format: parser.format, trusted: problem === null, problem },
    check: { stage: step.stage, blocking: step.blocking },
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
