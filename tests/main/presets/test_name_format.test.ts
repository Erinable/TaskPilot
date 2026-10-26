// [人工决策-2026-10-25 23:51:35] 测试名保持精确匹配，只在 prompt 里注入名字格式（CARM-16 决策 A）。
// Each preset's testNameFormat, as Product Lead and Coding Agent are told
// it, against what its test step really reports: a criterion written the
// way the prompt says is verified, never missing. The outputs are real runs
// of vitest 5.0.3 (JUnit reporter), pytest 9.1.1 (JUnit) and cargo test.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import * as checkOutput from '../../../src/main/check_output.ts';
import * as evidence from '../../../src/main/evidence.ts';
import * as testReport from '../../../src/main/test_report.ts';
import { pythonPreset } from '../../../src/main/presets/python.ts';
import { rustPreset } from '../../../src/main/presets/rust.ts';
import { typescriptPreset } from '../../../src/main/presets/typescript.ts';
import type { TestResult } from '../../../src/main/check_output.ts';

const FIXTURES = path.join(import.meta.dirname, '../fixtures');
const read = (file: string) => fs.readFile(path.join(FIXTURES, file), 'utf8');
const CHECK = { kind: 'test', stage: 'submit', blocking: true } as const;

// The names a format quotes as examples, e.g. "auth > login > x".
const examples = (format: string) => [...format.matchAll(/e\.g\. "([^"]+)"/g)].map((match) => match[1]);

const statuses = (results: TestResult[], names: string[]) => {
  const run = {
    kind: 'test',
    command: 'test',
    exitCode: 1,
    timedOut: false,
    durationMs: 1,
    output: '',
    results,
    report: { format: 'tests', trusted: true, problem: null },
  };
  const items = [evidence.evaluate(CHECK, run, null)];
  return evidence
    .criteriaStatus(
      names.map((name) => ({ text: name, test: name })),
      { test: run },
      items,
    )
    .map((criterion) => criterion.status);
};

test('vitest: "describe > title" names match the JUnit report', async () => {
  const results = testReport.parseJunit(await read('typescript_output/vitest_junit.xml'));
  assert.deepEqual(examples(typescriptPreset.testNameFormat), ['auth > login > locks after five failures', 'exports login']);
  assert.deepEqual(statuses(results, examples(typescriptPreset.testNameFormat)), ['verified', 'verified']);
  assert.deepEqual(statuses(results, ['auth > login > rejects a bad password']), ['failed']);
  // Exact match only: a bare title inside a describe() is not the test's name.
  assert.deepEqual(statuses(results, ['locks after five failures']), ['missing']);
});

test('pytest: the bare function name matches the JUnit report', async () => {
  const results = testReport.parseJunit(await read('python_output/pytest.xml'));
  assert.deepEqual(examples(pythonPreset.testNameFormat), ['test_locks_after_five_failures', 'test_rate[1]']);
  assert.deepEqual(statuses(results, ['test_adds_two_numbers', 'test_broken']), ['verified', 'failed']);
  // A node id is not what the report names a test.
  assert.deepEqual(statuses(results, ['tests/test_demo.py::test_adds_two_numbers']), ['missing']);
});

test('libtest: the module path inside the crate matches cargo test output', async () => {
  const output = (await read('rust_output/cargo_test.stdout.txt')) + (await read('rust_output/cargo_test.stderr.txt'));
  const results = checkOutput.parseResults(output);
  assert.match(rustPreset.testNameFormat, /"auth::tests::locks_after_five_failures"/);
  assert.deepEqual(statuses(results, ['tests::adds_two_numbers', 'tests::broken']), ['verified', 'failed']);
  assert.deepEqual(statuses(results, ['adds_two_numbers']), ['missing']);
});

test('libtest: nextest reports the same names', async () => {
  const results = checkOutput.parseResults(await read('rust_output/nextest.jsonl'));
  assert.deepEqual(statuses(results, ['tests::adds_two_numbers']), ['verified']);
});
