import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as evidence from '../../src/main/evidence.ts';
import type { ReportInfo, TestResult } from '../../src/main/verification.ts';

const CHECK: any = { kind: 'test', stage: 'submit', blocking: true };
const r = (name, passed): TestResult => ({ name, fullName: `suite › ${name}`, passed, skipped: false, todo: false });
const run = ({
  exitCode = 0,
  timedOut = false,
  results = [] as TestResult[],
  report = { format: 'stdout', trusted: true, problem: null } as ReportInfo,
} = {}): any => ({
  kind: 'test',
  command: 'npm test',
  exitCode,
  timedOut,
  durationMs: 5,
  output: '',
  results,
  report,
});
const baseline = (source) => evidence.baselineRecord(source, 'npm test', 'T');

test('baselineRecord() keys tests by full name and flags a crashed runner', () => {
  const record = baseline(run({ exitCode: 1, results: [r('a', true), r('b', false)] }));
  assert.deepEqual(record.failing, ['suite › b']);
  assert.deepEqual(record.passing, ['suite › a']);
  assert.equal(record.crashed, false);
  assert.equal(baseline(run({ exitCode: 2 })).crashed, true);
  assert.equal(baseline(run({ exitCode: 1, report: { format: 'junit', trusted: false, problem: 'missing' } })).crashed, true);
});

test('usableBaseline() requires a measurement for the same command line', () => {
  const record = baseline(run());
  assert.equal(evidence.usableBaseline(record, 'npm test'), record);
  assert.equal(evidence.usableBaseline(record, 'npm run test:ci'), null);
  assert.equal(evidence.usableBaseline({ ...record, status: 'contaminated' } as any, 'npm test'), null);
  assert.equal(evidence.usableBaseline(null, 'npm test'), null);
});

// One row per line of the design's decision table.
const TABLE = [
  ['clean run', run({ results: [r('a', true)] }), null, 'pass', null],
  ['new failure', run({ exitCode: 1, results: [r('a', false)] }), baseline(run({ results: [r('a', true)] })), 'fail', 'new_failures'],
  [
    'only preexisting failures',
    run({ exitCode: 1, results: [r('a', false), r('b', true)] }),
    baseline(run({ exitCode: 1, results: [r('a', false)] })),
    'pass',
    'preexisting_only',
  ],
  ['failure with no baseline', run({ exitCode: 1, results: [r('a', false)] }), null, 'fail', 'no_baseline'],
  ['crash, crashed the same at baseline', run({ exitCode: 2 }), baseline(run({ exitCode: 2 })), 'unverifiable', 'broken_at_baseline'],
  ['crash, healthy at baseline', run({ exitCode: 2 }), baseline(run({ results: [r('a', true)] })), 'fail', 'crashed'],
  ['crash with no baseline', run({ exitCode: 2 }), null, 'fail', 'crashed'],
  ['clean exit, stale report', run({ report: { format: 'junit', trusted: false, problem: 'stale' } }), null, 'unverifiable', 'report_stale'],
  ['failing exit, missing report', run({ exitCode: 1, report: { format: 'junit', trusted: false, problem: 'missing' } }), null, 'fail', 'report_missing'],
  ['timeout', run({ exitCode: 1, timedOut: true }), baseline(run()), 'fail', 'timed_out'],
  ['timeout at baseline too', run({ exitCode: 1, timedOut: true }), baseline(run({ exitCode: 1, timedOut: true })), 'unverifiable', 'timed_out_at_baseline'],
  ['could not start', { error: { code: 'command_missing' } }, null, 'unverifiable', 'command_missing'],
];

for (const [label, current, base, status, reason] of TABLE) {
  test(`evaluate(): ${label} → ${status}`, () => {
    const result = evidence.evaluate(CHECK, current, base);
    assert.equal(result.status, status);
    assert.equal(result.reason, reason);
    assert.equal(result.baseline, base ? 'measured' : 'none');
  });
}

test('evaluate() lists new, preexisting and fixed tests separately', () => {
  const base = baseline(run({ exitCode: 1, results: [r('old', false), r('fixme', false), r('ok', true)] }));
  const result = evidence.evaluate(CHECK, run({ exitCode: 1, results: [r('old', false), r('fixme', true), r('ok', false)] }), base);
  assert.deepEqual(result.newFailures, ['suite › ok']);
  assert.deepEqual(result.preexisting, ['suite › old']);
  assert.deepEqual(result.fixed, ['suite › fixme']);
  assert.equal(result.status, 'fail');
});

test('criteriaStatus() matches by name or full name and degrades to unverifiable', () => {
  const criteria = [{ text: 'one', test: 'a' }, { text: 'two', test: 'suite › b' }, { text: 'three', test: 'missing' }, { text: 'four' }];
  const runs = { test: run({ exitCode: 1, results: [r('a', true), r('b', false)] }) };
  const items = [evidence.evaluate(CHECK, runs.test, null)];
  const statuses = evidence.criteriaStatus(criteria, runs, items).map((c) => c.status);
  assert.deepEqual(statuses, ['verified', 'failed', 'missing', 'manual']);

  // When a check's results could not be read, a missing test is unverifiable, not missing.
  const unreadable = { test: run({ report: { format: 'junit', trusted: false, problem: 'invalid' } }) };
  const fromUnreadable = evidence.criteriaStatus(criteria, unreadable, [evidence.evaluate(CHECK, unreadable.test, null)]);
  assert.deepEqual(
    fromUnreadable.map((c) => c.status),
    ['unverifiable', 'unverifiable', 'unverifiable', 'manual'],
  );
});

test('criteriaStatus() flags a linked test that already passed at the baseline', () => {
  const runs = { test: run({ results: [r('a', true)] }) };
  const baselines = { test: baseline(run({ results: [r('a', true)] })) };
  const [criterion] = evidence.criteriaStatus([{ text: 'one', test: 'a' }], runs, [evidence.evaluate(CHECK, runs.test, baselines.test)], baselines);
  assert.equal(criterion.status, 'verified');
  assert.equal(criterion.alreadyPassing, true);
});

test('attention() collects what a human should look at', () => {
  const base = baseline(run({ exitCode: 1, results: [r('old', false)] }));
  const items = [
    evidence.evaluate(CHECK, run({ exitCode: 1, results: [r('old', false)] }), base),
    evidence.evaluate({ kind: 'smoke', stage: 'submit', blocking: true }, run({ exitCode: 3 }), baseline(run({ exitCode: 3 }))),
  ];
  const codes = evidence.attention(items, [{ status: 'manual' }]).map((a) => a.code);
  assert.deepEqual(codes, ['preexisting_failures', 'check_unverifiable', 'criterion_manual']);
});
