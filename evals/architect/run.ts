#!/usr/bin/env node
// Runs Architect's two jobs against the eval cases with the real Claude CLI:
// the interface summary for a requirement, and rulings on deviations.
//
//   npm run eval:architect                               all cases
//   npm run eval:architect -- --case replan-missing-method one case
//   npm run eval:architect -- --label v2                 names the report
//   npm run eval:architect -- --no-judge                 checks only
//
// Costs real money, so it is not part of `npm test`. Reports go to
// evals/architect/reports/ (gitignored).
import * as cli from '../../src/main/agents/claude_cli.ts';
import { adjudicateDeviation, summarizeForRequirement } from '../../src/main/agents/pipeline.ts';
import { fixtureRepo, judgeWith, runSuite } from '../shared/harness.ts';
import { cases } from './cases.ts';
import { checkAdjudication, checkSummary } from './checks.ts';
import type { ArchitectCase } from './cases.ts';

const CRITERIA = {
  accuracy: 'Everything stated matches the source code: signatures, behaviour, error conventions. Nothing invented.',
  relevance: 'It covers what this requirement or deviation needs, and leaves out what it does not.',
  reasoning:
    'For a ruling: the decision follows from the code and the plan, and the reason says why. For a summary: notes and gaps flag what a planner would otherwise get wrong.',
};
type Criterion = keyof typeof CRITERIA;

const SYSTEM = [
  'You are a strict reviewer of a software architect agent. You see the source code it had, the task, and its output.',
  'Score each criterion from 1 (poor) to 5 (excellent). 3 means acceptable with clear flaws. Reserve 5 for output you would not change.',
  'Give a one-sentence reason naming the specific flaw or strength. Write reasons in English.',
].join('\n');

const sourceBlock = (sources: Record<string, string>) =>
  Object.entries(sources)
    .map(([file, content]) => `<file path="${file}">\n${content}\n</file>`)
    .join('\n\n');

const runCase = async (testCase: ArchitectCase, { judge }: { judge: boolean }) => {
  const started = Date.now();
  const repo = await fixtureRepo(testCase.id, {
    ...Object.fromEntries((testCase.kind === 'summary' ? testCase.files : []).map((file) => [file, ''])),
    ...testCase.sources,
  });
  try {
    let run: unknown;
    let checks;
    let agentCostUsd: number;
    let judgeTask: string;
    if (testCase.kind === 'summary') {
      const result = await summarizeForRequirement(testCase.requirement, { runAgent: cli.runStructured, root: repo.root, files: testCase.files });
      if (result.error) throw Object.assign(new Error(result.error.message), { code: result.error.code });
      const read = result.read.map((entry) => entry.path);
      run = { read, summary: result.summary, skipped: result.skipped };
      checks = checkSummary(testCase, { read, summary: result.summary, text: result.text });
      agentCostUsd = result.costUsd;
      judgeTask = ['<requirement>', testCase.requirement.text, '</requirement>', '', '<output>', result.text ?? '(none)', '</output>'].join('\n');
    } else {
      const result = await adjudicateDeviation(testCase.task, {
        root: repo.root,
        deviations: testCase.deviations,
        mustReplan: testCase.mustReplan ?? false,
        runAgent: cli.runStructured,
      });
      run = result;
      checks = checkAdjudication(testCase, result);
      agentCostUsd = result.costUsd;
      judgeTask = [
        '<work_package>',
        JSON.stringify(testCase.task, null, 2),
        '</work_package>',
        '',
        '<deviations>',
        JSON.stringify(testCase.deviations, null, 2),
        '</deviations>',
        '',
        '<output>',
        JSON.stringify({ decision: result.decision, reason: result.reason, changes: result.changes, revision: result.revision }, null, 2),
        '</output>',
      ].join('\n');
    }
    let scores = null;
    let judgeCostUsd = 0;
    if (judge) {
      const judged = await judgeWith<Criterion>(CRITERIA, SYSTEM, ['<source_code>', sourceBlock(testCase.sources), '</source_code>', '', judgeTask].join('\n'));
      scores = judged.scores;
      judgeCostUsd = judged.costUsd;
    }
    return { id: testCase.id, seconds: Math.round((Date.now() - started) / 1000), agentCostUsd, judgeCostUsd, run, checks, scores };
  } finally {
    await repo.cleanup();
  }
};

runSuite({ suiteDir: import.meta.dirname, cases, criteria: Object.keys(CRITERIA) as Criterion[], runCase }).catch((error) => {
  console.error(error);
  process.exit(1);
});
