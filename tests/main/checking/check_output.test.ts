import { test } from 'vitest';
import assert from 'node:assert/strict';

import * as checkOutput from '../../../src/main/checking/check_output.ts';

const ROOT = '/private/tmp/tp-sample';
const place = { root: ROOT, cwd: '' };

// Real `eslint -f json` output (ESLint 9), trimmed to the fields TaskPilot reads.
const ESLINT = JSON.stringify([
  {
    filePath: `${ROOT}/src/a.ts`,
    messages: [{ ruleId: null, fatal: false, severity: 1, message: 'File ignored because no matching configuration was supplied.', nodeType: null }],
  },
  {
    filePath: `${ROOT}/src/b.js`,
    messages: [{ ruleId: 'prefer-const', severity: 2, message: "'y' is never reassigned. Use 'const' instead.", line: 1, column: 5, nodeType: 'Identifier' }],
  },
]);

// Real `tsc --noEmit` output.
const TSC = "src/a.ts(2,14): error TS2322: Type 'string' is not assignable to type 'number'.\n";
const TSC_LINE = '^(?<file>[^\\s(][^(]*)\\((?<line>\\d+),(?<column>\\d+)\\): (?<severity>error|warning) (?<rule>TS\\d+): (?<message>.+)$';

// SARIF 2.1.0 as Semgrep or CodeQL write it.
const SARIF = JSON.stringify({
  version: '2.1.0',
  runs: [
    {
      tool: { driver: { name: 'semgrep' } },
      results: [
        {
          ruleId: 'no-eval',
          level: 'error',
          message: { text: 'eval is dangerous' },
          locations: [{ physicalLocation: { artifactLocation: { uri: 'src/run.js' }, region: { startLine: 12, startColumn: 3 } } }],
        },
        { ruleId: 'style', level: 'note', message: { text: 'consider a const' }, locations: [] },
      ],
    },
  ],
});

test('ESLint JSON becomes diagnostics with paths relative to the root', () => {
  const parsed = checkOutput.parseOutput({ format: 'json', dialect: 'eslint', path: null }, { ...place, output: ESLINT, content: ESLINT });
  assert.deepEqual(parsed?.diagnostics, [
    { file: 'src/a.ts', line: null, column: null, severity: 'warning', message: 'File ignored because no matching configuration was supplied.', rule: null },
    { file: 'src/b.js', line: 1, column: 5, severity: 'error', message: "'y' is never reassigned. Use 'const' instead.", rule: 'prefer-const' },
  ]);
  // Only errors count as failures, keyed without the line so moved code still matches.
  assert.deepEqual(
    parsed?.results.map((result) => [result.fullName, result.passed]),
    [["src/b.js › prefer-const › 'y' is never reassigned. Use 'const' instead.", false]],
  );
});

test('a tsc line parses through the TypeScript preset pattern', () => {
  const parsed = checkOutput.parseOutput({ format: 'regex', pattern: TSC_LINE, severity: 'error' }, { ...place, output: TSC, content: TSC });
  assert.deepEqual(parsed?.diagnostics, [
    { file: 'src/a.ts', line: 2, column: 14, severity: 'error', message: "Type 'string' is not assignable to type 'number'.", rule: 'TS2322' },
  ]);
});

test('a regex without a message group uses the matched text', () => {
  const found = checkOutput.parseRegex('ok\nFAILED: thing broke\n', '^FAILED', 'warning', ROOT, '');
  assert.deepEqual(found, [{ file: null, line: null, column: null, severity: 'warning', message: 'FAILED', rule: null }]);
});

test('SARIF results map their level, location and rule', () => {
  const parsed = checkOutput.parseOutput({ format: 'sarif', path: null }, { ...place, output: '', content: SARIF });
  assert.deepEqual(parsed?.diagnostics, [
    { file: 'src/run.js', line: 12, column: 3, severity: 'error', message: 'eval is dangerous', rule: 'no-eval' },
    { file: null, line: null, column: null, severity: 'info', message: 'consider a const', rule: 'style' },
  ]);
  assert.equal(parsed?.results.length, 1);
});

test("TaskPilot's own JSON dialect, behind npm's banner", () => {
  const output =
    '\n> taskpilot@0.1.0 check\n> node check.ts\n\n{"diagnostics":[{"file":"scripts/x.ts","line":"7","severity":"warn","message":"too complex","rule":"complexity"}]}\n';
  const parsed = checkOutput.parseOutput({ format: 'json', dialect: 'diagnostics', path: null }, { ...place, output, content: output });
  assert.deepEqual(parsed?.diagnostics, [{ file: 'scripts/x.ts', line: 7, column: null, severity: 'warning', message: 'too complex', rule: 'complexity' }]);
});

test('output that is not in the configured format reads as unparseable, not as clean', () => {
  for (const parser of [
    { format: 'json', dialect: 'eslint', path: null },
    { format: 'json', dialect: 'diagnostics', path: null },
    { format: 'sarif', path: null },
  ] as const)
    assert.equal(checkOutput.parseOutput(parser, { ...place, output: 'Error: boom', content: 'Error: boom' }), null, parser.format);
});

test('tests output keeps the TAP and spec results and lists failures as diagnostics', () => {
  const parsed = checkOutput.parseOutput({ format: 'tests' }, { ...place, output: 'ok 1 - a\nnot ok 2 - b\n', content: '' });
  assert.deepEqual(
    parsed?.results.map((result) => [result.fullName, result.passed]),
    [
      ['a', true],
      ['b', false],
    ],
  );
  assert.deepEqual(parsed?.diagnostics, [{ file: null, line: null, column: null, severity: 'error', message: 'b', rule: null }]);
  assert.deepEqual(checkOutput.parseOutput({ format: 'exitcode' }, { ...place, output: 'anything', content: '' }), { results: [], diagnostics: [] });
});

test('relativeFile() resolves against the step directory and keeps outside paths as given', () => {
  assert.equal(checkOutput.relativeFile('src/a.ts', ROOT, 'app'), 'app/src/a.ts');
  assert.equal(checkOutput.relativeFile(`file://${ROOT}/lib/x.rs`, ROOT, ''), 'lib/x.rs');
  assert.equal(checkOutput.relativeFile('/usr/lib/node/x.js', ROOT, ''), '/usr/lib/node/x.js');
  assert.equal(checkOutput.relativeFile('', ROOT, ''), null);
});

test('severity words map onto error / warning / info', () => {
  assert.deepEqual(
    ['ERROR', 'warn', 'W', 'fatal', 'hint', '', undefined].map((word) => checkOutput.toSeverity(word, 'error')),
    ['error', 'warning', 'warning', 'error', 'info', 'error', 'error'],
  );
});

test('diagnostics are capped', () => {
  const lines = Array.from({ length: checkOutput.MAX_DIAGNOSTICS + 50 }, (_, index) => `f.ts:${index + 1}:1: bad`).join('\n');
  assert.equal(
    checkOutput.parseRegex(lines, '^(?<file>[^:]+):(?<line>\\d+):(?<column>\\d+): (?<message>.+)$', 'error', ROOT, '').length,
    checkOutput.MAX_DIAGNOSTICS,
  );
});
