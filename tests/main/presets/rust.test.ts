import { test, onTestFinished } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import * as checkOutput from '../../../src/main/check_output.ts';
import * as effectiveSteps from '../../../src/main/effective_steps.ts';
import * as verification from '../../../src/main/verification.ts';
import * as workspace from '../../../src/main/workspace.ts';
import { detectLanguages } from '../../../src/main/presets/index.ts';
import { parseCargoManifest, rustPreset } from '../../../src/main/presets/rust.ts';
import { env } from '../../../src/main/env.ts';
import type { CheckStep } from '../../../src/main/step_config.ts';

const run = promisify(execFile);
const FIXTURES = path.join(import.meta.dirname, '../fixtures');
// Real output of cargo 1.97 / clippy 0.1.97 / rustfmt 1.9 / nextest 0.9.82
// on the sample with an unused variable, a `len() == 0`, unformatted code
// and a failing test; the build sample also has an unclosed delimiter.
// Absolute paths were rewritten to /work/rust_sample, hashes zeroed.
const ROOT = '/work/rust_sample';
const sample = (name: string) => fs.readFile(path.join(FIXTURES, 'rust_output', name), 'utf8');
const place = { root: ROOT, cwd: '' };
const steps = rustPreset.steps({ manifest: parseCargoManifest('[package]\nname = "demo"\n'), nextest: false });
const parserOf = (id: 'build' | 'format' | 'lint' | 'test') => (steps[id] as CheckStep).parser;

test('clippy JSON becomes one diagnostic per finding, with the lint as the rule', async () => {
  const content = await sample('clippy.jsonl');
  const parsed = checkOutput.parseOutput(parserOf('lint'), { ...place, output: content, content });
  assert.deepEqual(parsed?.diagnostics, [
    { file: 'crates/demo/src/lib.rs', line: 5, column: 9, severity: 'warning', message: 'unused variable: `unused`', rule: 'unused_variables' },
    { file: 'crates/demo/src/lib.rs', line: 7, column: 8, severity: 'warning', message: 'length comparison to zero', rule: 'clippy::len_zero' },
  ]);
  // Warnings are listed, not failures.
  assert.deepEqual(parsed?.results, []);
});

test('a compile error in cargo build JSON is an error diagnostic and a failure', async () => {
  const content = await sample('cargo_build_error.jsonl');
  const parsed = checkOutput.parseOutput(parserOf('build'), { ...place, output: content, content });
  assert.deepEqual(parsed?.diagnostics, [
    { file: 'crates/demo/src/lib.rs', line: 31, column: 14, severity: 'error', message: 'this file contains an unclosed delimiter', rule: null },
  ]);
  assert.deepEqual(
    parsed?.results.map((result) => [result.fullName, result.passed]),
    [['crates/demo/src/lib.rs › this file contains an unclosed delimiter', false]],
  );
});

test('Cargo JSON relative to a member directory resolves against the step cwd', () => {
  const line = JSON.stringify({
    reason: 'compiler-message',
    message: {
      level: 'error',
      message: 'boom',
      code: { code: 'E0308' },
      spans: [{ file_name: 'src/lib.rs', line_start: 3, column_start: 1, is_primary: true }],
    },
  });
  assert.deepEqual(checkOutput.parseCargo(line, ROOT, 'crates/demo'), [
    { file: 'crates/demo/src/lib.rs', line: 3, column: 1, severity: 'error', message: 'boom', rule: 'E0308' },
  ]);
});

test('output with no Cargo message reads as unparseable, not as clean', () => {
  const output = 'error: could not find `Cargo.toml` in `/work` or any parent directory\n';
  assert.equal(checkOutput.parseOutput(parserOf('lint'), { ...place, output, content: output }), null);
  // A clean run still has its build-finished message.
  assert.deepEqual(checkOutput.parseCargo('{"reason":"build-finished","success":true}\n', ROOT, ''), []);
});

test('cargo fmt --check lists each hunk it would change', async () => {
  const output = await sample('cargo_fmt.txt');
  const parsed = checkOutput.parseOutput(parserOf('format'), { ...place, output, content: output });
  assert.deepEqual(parsed?.diagnostics, [{ file: 'crates/demo/src/lib.rs', line: 4, column: null, severity: 'error', message: 'Diff', rule: null }]);
});

test('cargo test results are scoped by test binary, from stdout and stderr together', async () => {
  // runStep() hands parsers stdout followed by stderr.
  const output = (await sample('cargo_test.stdout.txt')) + (await sample('cargo_test.stderr.txt'));
  const parsed = checkOutput.parseOutput(parserOf('test'), { ...place, output, content: '' });
  assert.deepEqual(
    parsed?.results.map((result) => [result.fullName, result.passed, result.skipped]),
    [
      ['demo › tests::ignored_case', true, true],
      ['demo › tests::adds_two_numbers', true, false],
      ['demo › tests::broken', false, false],
    ],
  );
  assert.deepEqual(parsed?.diagnostics, [{ file: null, line: null, column: null, severity: 'error', message: 'demo › tests::broken', rule: null }]);
});

test('libtest blocks pair with their binaries in run order; without every name they stay bare', () => {
  const output = [
    'running 1 test\ntest it_works ... ok\n',
    'running 1 test\ntest it_works ... FAILED\n',
    'running 0 tests\n',
    '     Running unittests src/lib.rs (target/debug/deps/core-0123456789abcdef)',
    '     Running tests/api.rs (target/debug/deps/api-0123456789abcdef)',
    '   Doc-tests core',
  ].join('\n');
  assert.deepEqual(
    checkOutput.parseLibtest(output).map((result) => [result.fullName, result.passed]),
    [
      ['core › it_works', true],
      ['api › it_works', false],
    ],
  );
  assert.deepEqual(
    checkOutput.parseLibtest('running 1 test\ntest it_works ... ok\n').map((result) => result.fullName),
    ['it_works'],
  );
});

test("nextest's libtest-json gives each test once, scoped by binary", async () => {
  const output = await sample('nextest.jsonl');
  const parsed = checkOutput.parseOutput({ format: 'tests' }, { ...place, output, content: output });
  assert.deepEqual(
    parsed?.results.map((result) => [result.fullName, result.passed, result.skipped]),
    [
      ['demo › tests::ignored_case', true, true],
      ['demo › tests::adds_two_numbers', true, false],
      ['demo › tests::broken', false, false],
    ],
  );
});

test('the Rust preset is recommended for Cargo.toml and fills every step', () => {
  assert.deepEqual(detectLanguages(new Set(['Cargo.toml'])), [{ manifest: 'Cargo.toml', language: 'Rust', preset: 'rust' }]);
  assert.deepEqual(Object.keys(steps), ['setup', 'build', 'format', 'lint', 'test']);
  assert.deepEqual(steps.lint?.commands, [{ command: 'cargo', args: ['clippy', '--workspace', '--all-targets', '--message-format=json'] }]);
  assert.deepEqual(steps.test?.commands, [{ command: 'cargo', args: ['test', '--workspace', '--no-fail-fast'] }]);
  assert.deepEqual(rustPreset.steps({ manifest: null, nextest: false }), {});
  assert.deepEqual(rustPreset.steps({ manifest: parseCargoManifest('[package'), nextest: false }), {});
  assert.deepEqual(
    rustPreset.tools.map((tool) => tool.command),
    ['cargo', 'rustup', 'cargo-clippy', 'rustfmt'],
  );
});

test('with cargo-nextest on PATH the test step uses it', () => {
  const nextest = rustPreset.steps({ manifest: parseCargoManifest('[workspace]\nmembers = ["a"]\n'), nextest: true });
  assert.deepEqual(nextest.test?.commands, [
    { command: 'cargo', args: ['nextest', 'run', '--workspace', '--no-fail-fast', '--message-format', 'libtest-json'] },
  ]);
  assert.deepEqual(nextest.test?.env, { NEXTEST_EXPERIMENTAL_LIBTEST_JSON: '1' });
});

test('parseCargoManifest() reads a package, a virtual workspace and broken TOML', () => {
  assert.deepEqual(parseCargoManifest('[package]\nname = "demo"\n'), { valid: true, package: 'demo', workspace: false });
  assert.deepEqual(parseCargoManifest('[workspace]\nmembers = ["crates/*"]\n'), { valid: true, package: null, workspace: true });
  assert.deepEqual(parseCargoManifest('[package\n'), { valid: false, package: null, workspace: false });
});

// End to end on tests/main/fixtures/rust_sample, a Cargo workspace: every
// preset step runs through TaskPilot's own runner. Needs the Rust toolchain.
const fixtureRepo = async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'taskpilot-rust-')));
  onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
  await fs.cp(path.join(FIXTURES, 'rust_sample'), root, { recursive: true, filter: (source) => !source.includes(`${path.sep}target`) });
  await fs.writeFile(path.join(root, 'taskpilot.toml'), 'preset = "rust"\n');
  const g = (args: string[]) => run('git', args, { cwd: root });
  await g(['init', '-b', 'main', '-q']);
  await g(['config', 'user.email', 't@e.com']);
  await g(['config', 'user.name', 'T']);
  await g(['add', '-A']);
  await g(['commit', '-qm', 'init']);
  return root;
};

const hasCargo = await workspace.resolveExecutable('cargo', { envPath: env.path }).then(Boolean);

test.skipIf(!hasCargo)(
  'every Rust preset step runs green on the sample workspace',
  async () => {
    const root = await fixtureRepo();
    const resolution = await effectiveSteps.resolve(workspace.normalize({ version: 3, root, steps: {} }), { envPath: env.path });
    assert.deepEqual(resolution.project, { status: 'ok', preset: 'rust' });
    const runnable = effectiveSteps.runnable(resolution);
    assert.deepEqual(
      runnable.map((step) => step.id),
      ['setup', 'build', 'format', 'lint', 'test'],
    );
    // With nextest installed the preset picks it; cargo test runs as well.
    const cargoTest = { ...(runnable.at(-1) as CheckStep), commands: [{ command: 'cargo', args: ['test', '--workspace', '--no-fail-fast'] }], env: {} };
    for (const step of [...runnable, cargoTest]) {
      const result = await verification.runStep(root, step, { envPath: env.path });
      const line = step.commands.map((entry) => [entry.command, ...entry.args].join(' ')).join(' && ');
      assert.equal(result.exitCode, 0, `${line}: ${result.output.slice(-2000)}`);
      assert.equal(result.report.trusted, true, line);
      assert.deepEqual(result.diagnostics, [], line);
      // nextest's experimental JSON does not always report ignored tests.
      if (step.id === 'test')
        assert.deepEqual(
          result.results.filter((entry) => !entry.skipped).map((entry) => [entry.fullName, entry.passed]),
          [['demo › tests::adds_two_numbers', true]],
          line,
        );
    }
  },
  240_000,
);
