#!/usr/bin/env node
// Runs Product Lead against the eval fixtures with the real Claude CLI.
//
//   npm run eval:product-lead                 all cases
//   npm run eval:product-lead -- --case vague one case
//   npm run eval:product-lead -- --label v2   names the report
//   npm run eval:product-lead -- --no-judge   skips the rubric judge
//
// Costs real money (roughly $0.3–0.5 per case with the judge), so it is not
// part of `npm test`. Reports are written to evals/product-lead/reports/.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { summarizeForRequirement } from '../../src/main/agents/pipeline.ts';
import * as cli from '../../src/main/agents/claude_cli.ts';
import * as productLead from '../../src/main/agents/product_lead.ts';
import { cases, answerFor } from './fixtures.ts';
import { check } from './checks.ts';
import { CRITERIA, judge } from './judge.ts';
import type { EvalCase } from './fixtures.ts';
import type { CheckResult, EvalRun } from './checks.ts';
import type { Criterion, Scores } from './judge.ts';
import type { SummaryResult } from '../../src/main/agents/pipeline.ts';
import type { JsonSchema } from '../../src/main/agents/claude_cli.ts';

interface Args {
  case: string | null;
  label: string;
  judge: boolean;
  concurrency: number;
  architect: boolean;
}

interface CaseRun extends EvalRun {
  architect: Pick<SummaryResult, 'text' | 'skipped' | 'error'> & { read: string[] } | null;
}

interface CaseResult {
  id: string;
  seconds: number;
  agentCostUsd: number;
  judgeCostUsd: number;
  run: CaseRun;
  checks: Record<string, CheckResult>;
  scores: Scores | null;
  error?: undefined;
}

interface CaseError {
  id: string;
  error: string;
}

// Same test as `r.error` before; a guard because an empty string does not narrow.
const isCaseError = (r: CaseResult | CaseError): r is CaseError => Boolean(r.error);

const parseArgs = (argv: string[]): Args => {
  const args: Args = { case: null, label: 'run', judge: true, concurrency: 3, architect: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--case') args.case = argv[++i];
    else if (argv[i] === '--label') args.label = argv[++i];
    else if (argv[i] === '--no-judge') args.judge = false;
    else if (argv[i] === '--architect') args.architect = true;
    else if (argv[i] === '--concurrency') args.concurrency = Number(argv[++i]);
  }
  return args;
};

const git = promisify(execFile);

// Materializes a fixture as a committed git repository, so Architect reads
// through the same repo_reader path the app uses. Files without contents
// become empty stubs.
const fixtureRepo = async (testCase: EvalCase): Promise<string> => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `tp-eval-${testCase.id}-`));
  for (const file of testCase.files) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), testCase.sources?.[file] ?? '');
  }
  const run = (args: string[]) => git('git', args, { cwd: root });
  await run(['init', '-q', '-b', 'main']);
  await run(['-c', 'user.email=e@x', '-c', 'user.name=eval', 'add', '-A']);
  await run(['-c', 'user.email=e@x', '-c', 'user.name=eval', 'commit', '-qm', 'fixture']);
  return root;
};

const runCase = async (testCase: EvalCase, { withJudge, withArchitect }: { withJudge: boolean; withArchitect: boolean }): Promise<CaseResult> => {
  const started = Date.now();
  const base: { title: string; text: string; files: string[]; interfaces?: string | null } = {
    title: testCase.requirement.title, text: testCase.requirement.text, files: testCase.files,
  };

  let architect: SummaryResult | null = null;
  if (withArchitect && testCase.files.length) {
    const root = await fixtureRepo(testCase);
    try {
      architect = await summarizeForRequirement(base, { runAgent: cli.runStructured, root, files: testCase.files });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
    base.interfaces = architect.text;
  }
  const call = (prompt: string, schema: JsonSchema) => cli.runStructured({ prompt, systemPrompt: productLead.SYSTEM_PROMPT, schema });

  const c = await call(productLead.clarifyPrompt(base), productLead.CLARIFY_SCHEMA);
  const clarify = productLead.validateClarify(c.output);
  const answers = clarify.questions.map((question) => answerFor(testCase, question));

  const questions = clarify.questions.map((text, i) => ({ text, answer: answers[i] }));
  const p = await call(productLead.planPrompt({ ...base, questions }), productLead.PLAN_SCHEMA);
  const plan = productLead.validatePlan(p.output);

  const run: CaseRun = { clarify, answers, plan, architect: architect && { text: architect.text, read: architect.read.map((r) => r.path), skipped: architect.skipped, error: architect.error } };
  const checks = check(testCase, run);
  let scores: Scores | null = null;
  let judgeCost = 0;
  if (withJudge) {
    const judged = await judge(testCase, run);
    scores = judged.scores;
    judgeCost = judged.costUsd ?? 0;
  }
  return {
    id: testCase.id,
    seconds: Math.round((Date.now() - started) / 1000),
    agentCostUsd: (c.costUsd ?? 0) + (p.costUsd ?? 0) + (architect?.costUsd ?? 0),
    judgeCostUsd: judgeCost,
    run,
    checks,
    scores,
  };
};

// Runs tasks with a concurrency limit, keeping input order.
const pool = async <T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> => {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index]);
    }
  }));
  return results;
};

const summarize = (results: (CaseResult | CaseError)[]) => {
  const ok = results.filter((r): r is CaseResult => !isCaseError(r));
  const checkNames = [...new Set(ok.flatMap((r) => Object.keys(r.checks)))];
  const checkRates = Object.fromEntries(checkNames.map((name) => {
    const applicable = ok.filter((r) => r.checks[name]);
    return [name, `${applicable.filter((r) => r.checks[name].pass).length}/${applicable.length}`];
  }));
  const judged = ok.filter((r): r is CaseResult & { scores: Scores } => r.scores !== null);
  const scoreMeans = Object.fromEntries((Object.keys(CRITERIA) as Criterion[]).map((key) => [
    key,
    judged.length ? Math.round((judged.reduce((sum, r) => sum + r.scores[key].score, 0) / judged.length) * 100) / 100 : null,
  ]));
  const passed = ok.reduce((sum, r) => sum + Object.values(r.checks).filter((c) => c.pass).length, 0);
  const total = ok.reduce((sum, r) => sum + Object.values(r.checks).length, 0);
  return {
    cases: results.length,
    errors: results.filter(isCaseError).length,
    checkPassRate: total ? Math.round((passed / total) * 1000) / 10 : null,
    checkRates,
    scoreMeans,
    // Every mean is a number once anything was judged.
    meanScore: judged.length ? Math.round(((Object.values(scoreMeans) as number[]).reduce((a, b) => a + b, 0) / Object.keys(CRITERIA).length) * 100) / 100 : null,
    agentCostUsd: Math.round(ok.reduce((sum, r) => sum + r.agentCostUsd, 0) * 1000) / 1000,
    judgeCostUsd: Math.round(ok.reduce((sum, r) => sum + r.judgeCostUsd, 0) * 1000) / 1000,
  };
};

const printTable = (results: (CaseResult | CaseError)[], summary: ReturnType<typeof summarize>) => {
  const pad = (text: string | number, width: number) => String(text).padEnd(width);
  console.log(`\n${pad('case', 15)}${pad('Q', 4)}${pad('pkgs', 6)}${pad('hours', 7)}${pad('checks', 9)}judge`);
  for (const r of results) {
    if (isCaseError(r)) {
      console.log(`${pad(r.id, 15)}ERROR ${r.error}`);
      continue;
    }
    const checks = Object.values(r.checks);
    const hours = r.run.plan.packages.reduce((sum, pkg) => sum + pkg.estimateHours, 0);
    const mean = r.scores ? (Object.values(r.scores).reduce((sum, s) => sum + s.score, 0) / Object.keys(CRITERIA).length).toFixed(1) : '–';
    console.log(`${pad(r.id, 15)}${pad(r.run.clarify.questions.length, 4)}${pad(r.run.plan.packages.length, 6)}${pad(hours, 7)}${pad(`${checks.filter((c) => c.pass).length}/${checks.length}`, 9)}${mean}`);
    for (const [name, result] of Object.entries(r.checks)) if (!result.pass) console.log(`    ✗ ${name}: ${result.detail}`);
    if (r.scores) for (const [key, s] of Object.entries(r.scores)) if (s.score <= 3) console.log(`    ${s.score} ${key}: ${s.reason}`);
  }
  console.log(`\nchecks ${summary.checkPassRate}%  ${JSON.stringify(summary.checkRates)}`);
  console.log(`judge  mean ${summary.meanScore}  ${JSON.stringify(summary.scoreMeans)}`);
  console.log(`cost   agent $${summary.agentCostUsd}  judge $${summary.judgeCostUsd}`);
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const selected = args.case ? cases.filter((c) => c.id === args.case) : cases;
  if (selected.length === 0) throw new Error(`No case named ${args.case}`);

  const results = await pool(selected, args.concurrency, async (testCase): Promise<CaseResult | CaseError> => {
    process.stderr.write(`· ${testCase.id}\n`);
    try {
      return await runCase(testCase, { withJudge: args.judge, withArchitect: args.architect });
    } catch (error) {
      const coded = error as Error & { code?: string };
      return { id: testCase.id, error: `${coded.code ?? ''} ${coded.message}`.trim() };
    }
  });

  const summary = summarize(results);
  const dir = path.join(import.meta.dirname, 'reports');
  await fs.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(dir, `${stamp}-${args.label}.json`);
  await fs.writeFile(file, `${JSON.stringify({ label: args.label, summary, results }, null, 2)}\n`);
  printTable(results, summary);
  console.log(`report ${path.relative(process.cwd(), file)}`);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
