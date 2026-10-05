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
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { summarizeForRequirement } = require('../../src/agents/pipeline');
const cli = require('../../src/agents/claude-cli');
const productLead = require('../../src/agents/product-lead');
const { cases, answerFor } = require('./fixtures');
const { check } = require('./checks');
const { CRITERIA, judge } = require('./judge');

function parseArgs(argv) {
  const args = { case: null, label: 'run', judge: true, concurrency: 3, architect: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--case') args.case = argv[++i];
    else if (argv[i] === '--label') args.label = argv[++i];
    else if (argv[i] === '--no-judge') args.judge = false;
    else if (argv[i] === '--architect') args.architect = true;
    else if (argv[i] === '--concurrency') args.concurrency = Number(argv[++i]);
  }
  return args;
}

const git = promisify(execFile);

/**
 * Materializes a fixture as a committed git repository, so Architect reads
 * through the same repo-reader path the app uses. Files without contents
 * become empty stubs.
 */
async function fixtureRepo(testCase) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `tp-eval-${testCase.id}-`));
  for (const file of testCase.files) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), testCase.sources[file] ?? '');
  }
  const run = (args) => git('git', args, { cwd: root });
  await run(['init', '-q', '-b', 'main']);
  await run(['-c', 'user.email=e@x', '-c', 'user.name=eval', 'add', '-A']);
  await run(['-c', 'user.email=e@x', '-c', 'user.name=eval', 'commit', '-qm', 'fixture']);
  return root;
}

async function runCase(testCase, { withJudge, withArchitect }) {
  const started = Date.now();
  const base = { title: testCase.requirement.title, text: testCase.requirement.text, files: testCase.files };

  let architect = null;
  if (withArchitect && testCase.files.length) {
    const root = await fixtureRepo(testCase);
    try {
      architect = await summarizeForRequirement(base, { runAgent: cli.runStructured, root, files: testCase.files });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
    base.interfaces = architect.text;
  }
  const call = (prompt, schema) => cli.runStructured({ prompt, systemPrompt: productLead.SYSTEM_PROMPT, schema });

  const c = await call(productLead.clarifyPrompt(base), productLead.CLARIFY_SCHEMA);
  const clarify = productLead.validateClarify(c.output);
  const answers = clarify.questions.map((question) => answerFor(testCase, question));

  const questions = clarify.questions.map((text, i) => ({ text, answer: answers[i] }));
  const p = await call(productLead.planPrompt({ ...base, questions }), productLead.PLAN_SCHEMA);
  const plan = productLead.validatePlan(p.output);

  const run = { clarify, answers, plan, architect: architect && { text: architect.text, read: architect.read.map((r) => r.path), skipped: architect.skipped, error: architect.error } };
  const checks = check(testCase, run);
  let scores = null;
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
}

/** Runs tasks with a concurrency limit, keeping input order. */
async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index]);
    }
  }));
  return results;
}

function summarize(results) {
  const ok = results.filter((r) => !r.error);
  const checkNames = [...new Set(ok.flatMap((r) => Object.keys(r.checks)))];
  const checkRates = Object.fromEntries(checkNames.map((name) => {
    const applicable = ok.filter((r) => r.checks[name]);
    return [name, `${applicable.filter((r) => r.checks[name].pass).length}/${applicable.length}`];
  }));
  const judged = ok.filter((r) => r.scores);
  const scoreMeans = Object.fromEntries(Object.keys(CRITERIA).map((key) => [
    key,
    judged.length ? Math.round((judged.reduce((sum, r) => sum + r.scores[key].score, 0) / judged.length) * 100) / 100 : null,
  ]));
  const passed = ok.reduce((sum, r) => sum + Object.values(r.checks).filter((c) => c.pass).length, 0);
  const total = ok.reduce((sum, r) => sum + Object.values(r.checks).length, 0);
  return {
    cases: results.length,
    errors: results.filter((r) => r.error).length,
    checkPassRate: total ? Math.round((passed / total) * 1000) / 10 : null,
    checkRates,
    scoreMeans,
    meanScore: judged.length ? Math.round((Object.values(scoreMeans).reduce((a, b) => a + b, 0) / Object.keys(CRITERIA).length) * 100) / 100 : null,
    agentCostUsd: Math.round(ok.reduce((sum, r) => sum + r.agentCostUsd, 0) * 1000) / 1000,
    judgeCostUsd: Math.round(ok.reduce((sum, r) => sum + r.judgeCostUsd, 0) * 1000) / 1000,
  };
}

function printTable(results, summary) {
  const pad = (text, width) => String(text).padEnd(width);
  console.log(`\n${pad('case', 15)}${pad('Q', 4)}${pad('pkgs', 6)}${pad('hours', 7)}${pad('checks', 9)}judge`);
  for (const r of results) {
    if (r.error) {
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
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const selected = args.case ? cases.filter((c) => c.id === args.case) : cases;
  if (selected.length === 0) throw new Error(`No case named ${args.case}`);

  const results = await pool(selected, args.concurrency, async (testCase) => {
    process.stderr.write(`· ${testCase.id}\n`);
    try {
      return await runCase(testCase, { withJudge: args.judge, withArchitect: args.architect });
    } catch (error) {
      return { id: testCase.id, error: `${error.code ?? ''} ${error.message}`.trim() };
    }
  });

  const summary = summarize(results);
  const dir = path.join(__dirname, 'reports');
  await fs.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(dir, `${stamp}-${args.label}.json`);
  await fs.writeFile(file, `${JSON.stringify({ label: args.label, summary, results }, null, 2)}\n`);
  printTable(results, summary);
  console.log(`report ${path.relative(process.cwd(), file)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
