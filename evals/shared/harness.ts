// Plumbing shared by the QA, Architect and Tutor grading evals: argument parsing, a
// concurrency pool, fixture repositories and report files. Each suite keeps
// its own cases, checks and judge rubric.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import * as cliRunner from '../../src/main/runtimes/cli_runner.ts';
import type { JsonSchema, RunAgent } from '../../src/main/runtimes/claude_cli.ts';

// The model calls go through cli_runner, as the app's do, so the native
// Claude configuration (settings.json env such as a gateway token) applies.
// Calling claude_cli directly skips it and fails with "Not logged in".
// Per-call time limit for eval runs; set from --timeout-minutes by runSuite.
// The app keeps its own 3-minute limit; a slow gateway needs more here.
let timeoutMs = 10 * 60 * 1000;
export const runAgent: RunAgent = (options) => cliRunner.runStructured({ timeoutMs, ...options }, { cli: 'claude', model: '', thinking: 'default' });

export interface CheckResult {
  pass: boolean;
  detail: string;
}

export interface SuiteArgs {
  case: string | null;
  label: string;
  judge: boolean;
  concurrency: number;
  timeoutMinutes: number;
  // A course pack id the suite runs every case with, when it reads one.
  course: string | null;
}

export const parseArgs = (argv: string[]): SuiteArgs => {
  const args: SuiteArgs = { case: null, label: 'run', judge: true, concurrency: 3, timeoutMinutes: 10, course: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--case') args.case = argv[++index];
    else if (argv[index] === '--label') args.label = argv[++index];
    else if (argv[index] === '--no-judge') args.judge = false;
    else if (argv[index] === '--concurrency') args.concurrency = Number(argv[++index]);
    else if (argv[index] === '--timeout-minutes') args.timeoutMinutes = Number(argv[++index]);
    else if (argv[index] === '--course') args.course = argv[++index];
  }
  return args;
};

// Runs tasks with a concurrency limit, keeping input order.
export const pool = async <T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> => {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await worker(items[index]);
      }
    }),
  );
  return results;
};

const git = promisify(execFile);

// A committed git repository holding `files` (path -> contents), so agents
// read through the same repo_reader path the app uses. Removed by `cleanup`.
export const fixtureRepo = async (id: string, files: Record<string, string>): Promise<{ root: string; head: string; cleanup: () => Promise<void> }> => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `tp-eval-${id}-`));
  for (const [file, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), content);
  }
  const run = (args: string[]) => git('git', ['-c', 'user.email=e@x', '-c', 'user.name=eval', ...args], { cwd: root });
  await run(['init', '-q', '-b', 'main']);
  await run(['add', '-A']);
  await run(['commit', '-qm', 'fixture']);
  const head = (await run(['rev-parse', 'HEAD'])).stdout.trim();
  return { root, head, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
};

// Scores a run 1–5 per criterion through a separate Claude call.
export type Scores<Criterion extends string> = Record<Criterion, { score: number; reason: string }>;

export const judgeWith = async <Criterion extends string>(
  criteria: Record<Criterion, string>,
  system: string,
  prompt: string,
): Promise<{ scores: Scores<Criterion>; costUsd: number }> => {
  const keys = Object.keys(criteria);
  const schema: JsonSchema = {
    type: 'object',
    additionalProperties: false,
    required: keys,
    properties: Object.fromEntries(
      keys.map((key) => [
        key,
        {
          type: 'object',
          additionalProperties: false,
          required: ['score', 'reason'],
          properties: { score: { type: 'integer', minimum: 1, maximum: 5 }, reason: { type: 'string', maxLength: 300 } },
        },
      ]),
    ),
  };
  const fullPrompt = ['<criteria>', ...Object.entries(criteria).map(([key, text]) => `${key}: ${text}`), '</criteria>', '', prompt].join('\n');
  const { output, costUsd } = await runAgent({ prompt: fullPrompt, systemPrompt: system, schema });
  // Shape enforced by the schema through the CLI.
  return { scores: output as Scores<Criterion>, costUsd: costUsd ?? 0 };
};

export interface CaseOutcome<Run, Criterion extends string> {
  id: string;
  seconds: number;
  agentCostUsd: number;
  judgeCostUsd: number;
  run: Run;
  checks: Record<string, CheckResult>;
  scores: Scores<Criterion> | null;
}
export type CaseFailure = { id: string; error: string };

const isFailure = <Run, Criterion extends string>(result: CaseOutcome<Run, Criterion> | CaseFailure): result is CaseFailure => 'error' in result;
const round = (value: number, places: number) => Math.round(value * 10 ** places) / 10 ** places;

// Pass rates per check, judge means per criterion, and cost.
export const summarize = <Run, Criterion extends string>(results: (CaseOutcome<Run, Criterion> | CaseFailure)[], criteria: Criterion[]) => {
  const ok = results.filter((result): result is CaseOutcome<Run, Criterion> => !isFailure(result));
  const names = [...new Set(ok.flatMap((result) => Object.keys(result.checks)))];
  const passed = ok.reduce((sum, result) => sum + Object.values(result.checks).filter((item) => item.pass).length, 0);
  const total = ok.reduce((sum, result) => sum + Object.values(result.checks).length, 0);
  const judged = ok.filter((result): result is CaseOutcome<Run, Criterion> & { scores: Scores<Criterion> } => result.scores !== null);
  const scoreMeans = Object.fromEntries(
    criteria.map((key) => [key, judged.length ? round(judged.reduce((sum, result) => sum + result.scores[key].score, 0) / judged.length, 2) : null]),
  );
  return {
    cases: results.length,
    errors: results.filter(isFailure).length,
    checkPassRate: total ? round((passed / total) * 100, 1) : null,
    checkRates: Object.fromEntries(
      names.map((name) => {
        const applicable = ok.filter((result) => result.checks[name]);
        return [name, `${applicable.filter((result) => result.checks[name].pass).length}/${applicable.length}`];
      }),
    ),
    scoreMeans,
    meanScore: judged.length ? round((Object.values(scoreMeans) as number[]).reduce((a, b) => a + b, 0) / criteria.length, 2) : null,
    agentCostUsd: round(
      ok.reduce((sum, result) => sum + result.agentCostUsd, 0),
      3,
    ),
    judgeCostUsd: round(
      ok.reduce((sum, result) => sum + result.judgeCostUsd, 0),
      3,
    ),
  };
};

// Prints failures and low scores per case, then the summary, and writes
// reports/<stamp>-<label>.json beside the suite.
// `suite` adds checks across cases (e.g. a rubric's coverage), printed and
// written beside the summary.
export const report = async <Run, Criterion extends string>(
  suiteDir: string,
  label: string,
  results: (CaseOutcome<Run, Criterion> | CaseFailure)[],
  criteria: Criterion[],
  suite: Record<string, unknown> | null = null,
) => {
  const summary = summarize(results, criteria);
  for (const result of results) {
    if (isFailure(result)) {
      console.log(`${result.id.padEnd(28)}ERROR ${result.error}`);
      continue;
    }
    const checks = Object.values(result.checks);
    console.log(`${result.id.padEnd(28)}checks ${checks.filter((item) => item.pass).length}/${checks.length}`);
    for (const [name, item] of Object.entries(result.checks)) if (!item.pass) console.log(`    ✗ ${name}: ${item.detail}`);
    if (result.scores)
      for (const [key, score] of Object.entries(result.scores) as [string, { score: number; reason: string }][])
        if (score.score <= 3) console.log(`    ${score.score} ${key}: ${score.reason}`);
  }
  console.log(`\nchecks ${summary.checkPassRate}%  ${JSON.stringify(summary.checkRates)}`);
  console.log(`judge  mean ${summary.meanScore}  ${JSON.stringify(summary.scoreMeans)}`);
  console.log(`cost   agent $${summary.agentCostUsd}  judge $${summary.judgeCostUsd}`);
  if (suite) console.log(`suite  ${JSON.stringify(suite)}`);
  const dir = path.join(suiteDir, 'reports');
  await fs.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(dir, `${stamp}-${label}.json`);
  await fs.writeFile(file, `${JSON.stringify({ label, summary, ...(suite ? { suite } : {}), results }, null, 2)}\n`);
  console.log(`report ${path.relative(process.cwd(), file)}`);
};

// Runs every selected case and reports, turning a thrown case into an error row.
export const runSuite = async <Case extends { id: string }, Run, Criterion extends string>({
  suiteDir,
  cases,
  criteria,
  runCase,
  suite,
}: {
  suiteDir: string;
  cases: Case[];
  criteria: Criterion[];
  runCase: (testCase: Case, args: SuiteArgs) => Promise<CaseOutcome<Run, Criterion>>;
  suite?: (results: CaseOutcome<Run, Criterion>[]) => Record<string, unknown>;
}) => {
  const args = parseArgs(process.argv.slice(2));
  timeoutMs = args.timeoutMinutes * 60 * 1000;
  // --case takes one id or a comma-separated list.
  const wanted = args.case?.split(',') ?? null;
  const selected = wanted ? cases.filter((testCase) => wanted.includes(testCase.id)) : cases;
  if (!selected.length) throw new Error(`No case named ${args.case}`);
  const results = await pool(selected, args.concurrency, async (testCase): Promise<CaseOutcome<Run, Criterion> | CaseFailure> => {
    process.stderr.write(`· ${testCase.id}\n`);
    try {
      return await runCase(testCase, args);
    } catch (error) {
      const coded = error as Error & { code?: string };
      return { id: testCase.id, error: `${coded.code ?? ''} ${coded.message}`.trim() };
    }
  });
  const finished = results.filter((result): result is CaseOutcome<Run, Criterion> => !isFailure(result));
  await report(suiteDir, args.label, results, criteria, suite ? suite(finished) : null);
  // A run where every case errored produced no result; say so in the exit code.
  if (results.every((result) => 'error' in result)) process.exitCode = 1;
};
