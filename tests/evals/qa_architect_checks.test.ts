/** @module-tag integration */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { check } from '../../evals/qa/checks.ts';
import { cases as qaCases } from '../../evals/qa/cases.ts';
import { checkAdjudication, checkSummary } from '../../evals/architect/checks.ts';
import { cases as architectCases } from '../../evals/architect/cases.ts';
import { TS_API } from '../../evals/product-lead/sources.ts';
import { fixtureRepo, summarize } from '../../evals/shared/harness.ts';
import * as qa from '../../src/main/agents/qa.ts';
import * as architect from '../../src/main/agents/architect.ts';
import { reviewWorkPackage } from '../../src/main/agents/pipeline.ts';

const review = (verdict: 'pass' | 'reject', issues: { severity: 'blocker' | 'major' | 'minor'; file: string | null }[] = [], unmet: number[] = []) => {
  const report = {
    verdict,
    summary: 's',
    criteria: [0, 1, 2].map((index) => ({ index, status: unmet.includes(index) ? ('unmet' as const) : ('met' as const), note: null })),
    issues: issues.map((issue) => ({ ...issue, text: 't', line: 1 })),
  };
  const reasons = qa.decide({ acceptance: [], changeCount: 1, report });
  return { passed: reasons.length === 0, reasons, report };
};
const qaCase = (id: string) => qaCases.find((testCase) => testCase.id === id) as (typeof qaCases)[number];

test('QA cases: every change edits a fixture file and stays in scope', () => {
  for (const testCase of qaCases) {
    for (const file of Object.keys(testCase.change)) {
      assert.ok(file in TS_API, `${testCase.id}: ${file} is not in the fixture`);
      assert.ok(testCase.task.fileScope.includes(file), `${testCase.id}: ${file} is out of scope`);
      assert.notEqual(testCase.change[file], TS_API[file as keyof typeof TS_API], `${testCase.id}: ${file} is unchanged`);
    }
    assert.ok(
      testCase.task.acceptance.every((criterion) => !criterion.test || testCase.passingTests.includes(criterion.test)),
      `${testCase.id}: a linked test is not in the fixed run`,
    );
  }
});

test('QA checks: a clean case passes only without serious issues', () => {
  const clean = qaCase('clean-find-by-email');
  assert.ok(Object.values(check(clean, review('pass', [{ severity: 'minor', file: null }]))).every((item) => item.pass));
  const flagged = check(clean, review('pass', [{ severity: 'major', file: null }]));
  assert.equal(flagged.noFalseBlocker.pass, false);
  assert.equal(check(clean, review('reject')).outcome.pass, false);
});

test('QA checks: a planted bug must be rejected, located, judged and serious', () => {
  const injected = qaCase('injected-instruction');
  const caught = check(injected, review('reject', [{ severity: 'blocker', file: 'src/auth/user-repository.ts' }], [2]));
  assert.ok(
    Object.values(caught).every((item) => item.pass),
    JSON.stringify(caught),
  );
  const shallow = check(injected, review('reject', [{ severity: 'minor', file: 'tests/auth/user-repository.test.ts' }]));
  assert.deepEqual(
    Object.entries(shallow)
      .filter(([, item]) => !item.pass)
      .map(([name]) => name),
    ['locatesBug', 'serious', 'criteriaJudged'],
  );
  assert.equal(check(injected, { passed: false, reasons: ['tests_failed'], report: null }).reviewed.pass, false);
});

test('Architect cases: summary expectations name fixture files, replans name the scope they fix', () => {
  for (const testCase of architectCases) {
    if (testCase.kind === 'summary') {
      for (const file of testCase.expect.mustRead) assert.ok(testCase.files.includes(file) && file in testCase.sources, `${testCase.id}: ${file}`);
      for (const term of testCase.expect.grounding)
        assert.ok(
          Object.values(testCase.sources).some((source) => source.includes(term)),
          `${testCase.id}: ${term} is not in the code`,
        );
    } else if (testCase.expect.decision === 'dismiss') assert.equal(testCase.expect.scopeIncludes, undefined, testCase.id);
  }
});

test('Architect checks: selection, grounding and decisions', () => {
  const summaryCase = architectCases.find((testCase) => testCase.id === 'summary-clear-small');
  if (summaryCase?.kind !== 'summary') throw new Error('missing case');
  const module = { path: 'src/auth/user-repository.ts', purpose: 'p', members: [], dependsOn: [], notes: [] };
  const good = checkSummary(summaryCase, {
    read: ['src/auth/user-repository.ts'],
    summary: { modules: [module], conventions: [], gaps: [] },
    text: 'NotFoundError COLUMNS',
  });
  assert.ok(
    Object.values(good).every((item) => item.pass),
    JSON.stringify(good),
  );
  const thin = checkSummary(summaryCase, { read: ['src/db/client.ts'], summary: null, text: 'fakeDb' });
  assert.deepEqual([thin.summarized.pass, thin.selection.pass, thin.codeGrounding.pass], [false, false, false]);

  const replanCase = architectCases.find((testCase) => testCase.id === 'replan-missing-method');
  if (replanCase?.kind !== 'adjudicate') throw new Error('missing case');
  const replan = architect.validateAdjudication({
    decision: 'replan',
    reason: 'r',
    changes: [],
    revision: { steps: ['s'], fileScope: ['src/auth/user-repository.ts', 'src/http/router.ts'], acceptance: [{ text: 'a' }] },
  });
  assert.ok(Object.values(checkAdjudication(replanCase, replan)).every((item) => item.pass));
  assert.equal(checkAdjudication(replanCase, { decision: 'dismiss', reason: 'r', changes: [], revision: null }).decision.pass, false);
});

test('summarize() rates checks and averages judge scores across cases', () => {
  const ok = (id: string, pass: boolean, score: number) => ({
    id,
    seconds: 1,
    agentCostUsd: 0.1,
    judgeCostUsd: 0.05,
    run: null,
    checks: { outcome: { pass, detail: '' } },
    scores: { accuracy: { score, reason: '' } },
  });
  const summary = summarize([ok('a', true, 4), ok('b', false, 2), { id: 'c', error: 'boom' }], ['accuracy']);
  assert.deepEqual(summary.checkRates, { outcome: '1/2' });
  assert.equal(summary.checkPassRate, 50);
  assert.equal(summary.meanScore, 3);
  assert.equal(summary.errors, 1);
  assert.equal(summary.agentCostUsd, 0.2);
});

test.each(qaCases)('QA case $id reaches the model with its diff through the real pipeline', async (testCase) => {
  const repo = await fixtureRepo(testCase.id, TS_API);
  try {
    for (const [file, content] of Object.entries(testCase.change)) await fs.writeFile(path.join(repo.root, file), content);
    let prompt = '';
    const result = await reviewWorkPackage(testCase.task, {
      root: repo.root,
      baseline: repo.head,
      runAgent: async (options) => {
        prompt = options.prompt;
        return { output: { verdict: 'pass', summary: 's', criteria: [], issues: [] }, costUsd: 0 };
      },
      checks: [{ kind: 'test', stage: 'submit', blocking: true, line: 'npm test' }],
      runCheck: async () => ({
        kind: 'test',
        command: 'npm test',
        exitCode: 0,
        timedOut: false,
        durationMs: 1,
        output: '',
        results: testCase.passingTests.map((name) => ({ name, passed: true, skipped: false, todo: false })),
        summary: { total: 1, passed: 1, failed: 0, skipped: 0, ok: true },
        diagnostics: [],
        report: { format: 'tests', trusted: true, problem: null },
        check: { stage: 'submit', blocking: true },
      }),
    });
    assert.ok(result.report, `${testCase.id}: decided without the model (${result.reasons.join(', ')})`);
    for (const file of Object.keys(testCase.change)) assert.ok(prompt.includes(file), `${testCase.id}: ${file} missing from the prompt`);
    assert.deepEqual(result.diff.outOfScope, [], testCase.id);
  } finally {
    await repo.cleanup();
  }
});

test('QA clean cases check the query itself; planted-bug cases keep the weak suite', () => {
  const testFile = 'tests/auth/user-repository.test.ts';
  for (const testCase of qaCases) {
    const strong = testCase.change[testFile].includes("expect(calls[0].sql).toContain('lower(email) = lower($1)')");
    assert.equal(strong, testCase.expect.verdict === 'pass', testCase.id);
    assert.equal(testCase.passingTests.length, 3, testCase.id);
  }
});
