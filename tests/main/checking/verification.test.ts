import { test, onTestFinished, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tempDir } from '../../fixtures/temp_dir.ts';
import * as verification from '../../../src/main/checking/verification.ts';
import * as checkOutput from '../../../src/main/checking/check_output.ts';
import type { CheckStep } from '../../../src/main/checking/step_config.ts';
import type { TestResult } from '../../../src/main/checking/check_output.ts';

const step = (overrides: Partial<CheckStep> = {}): CheckStep => ({
  id: 'test',
  label: null,
  commands: [{ command: process.execPath, args: ['-e', 'process.exit(0)'] }],
  cwd: '',
  stage: 'submit',
  blocking: true,
  parser: { format: 'tests' },
  env: {},
  ...overrides,
});

const workspaceWith = async (commands) => {
  const root = await tempDir('taskpilot-verify-');
  return { root, commands };
};

test('summarize() excludes skipped and todo tests from the counts', () => {
  const summary = verification.summarize([{ passed: true }, { passed: false }, { passed: true, skipped: true }] as TestResult[], 1);
  assert.deepEqual(summary, { total: 2, passed: 1, failed: 1, skipped: 1, ok: false });
});

test('summarize() trusts the exit code even when no tests were parsed', () => {
  // A runner that crashes before emitting TAP must not read as success.
  assert.equal(verification.summarize([], 1).ok, false);
  assert.equal(verification.summarize([], 0).ok, true);
});

test('run() reports a passing command with parsed results', async () => {
  const config = await workspaceWith({
    test: { command: process.execPath, args: ['-e', "console.log('TAP version 13\\nok 1 - it works')"] },
  });
  const result = await verification.run(config, 'test');
  assert.equal(result.exitCode, 0);
  assert.equal(result.summary.ok, true);
  assert.deepEqual(
    result.results.map((r) => r.name),
    ['it works'],
  );
  assert.ok(result.durationMs >= 0);
});

test('run() reports a failing command with its output', async () => {
  const config = await workspaceWith({
    test: { command: process.execPath, args: ['-e', "console.log('not ok 1 - broken'); process.exit(1)"] },
  });
  const result = await verification.run(config, 'test');
  assert.equal(result.exitCode, 1);
  assert.equal(result.summary.failed, 1);
  assert.equal(result.summary.ok, false);
  assert.match(result.output, /not ok 1 - broken/);
});

test('run() captures stderr alongside stdout', async () => {
  const config = await workspaceWith({
    lint: { command: process.execPath, args: ['-e', "console.error('lint: 1 problem'); process.exit(2)"] },
  });
  const result = await verification.run(config, 'lint');
  assert.equal(result.exitCode, 2);
  assert.match(result.output, /lint: 1 problem/);
});

test('run() rejects a kind with no configured command', async () => {
  const config = await workspaceWith({});
  await assert.rejects(() => verification.run(config, 'build'), { code: 'not_configured' });
});

test('run() rejects when no workspace root is set', async () => {
  const config = { root: null, commands: { test: { command: 'node', args: [] } } };
  await assert.rejects(() => verification.run(config, 'test'), { code: 'no_workspace' });
  await assert.rejects(() => verification.runStep(null, step()), { code: 'no_workspace' });
});

test('run() reports a missing executable distinctly', async () => {
  const config = await workspaceWith({
    test: { command: 'taskpilot-no-such-binary', args: [] },
  });
  await assert.rejects(() => verification.run(config, 'test'), { code: 'command_missing' });
});

test('run() flags a command that exceeds its timeout', async () => {
  const config = await workspaceWith({
    test: { command: process.execPath, args: ['-e', 'setTimeout(() => {}, 30000)'] },
  });
  const result = await verification.run(config, 'test', { timeoutMs: 300 });
  assert.equal(result.timedOut, true);
  assert.equal(result.summary.ok, false);
});

test('run() hands envPath to the command as PATH', async () => {
  const config = await workspaceWith({
    test: { command: process.execPath, args: ['-e', 'console.log(process.env.PATH)'] },
  });
  const result = await verification.run(config, 'test', { envPath: '/tp/custom/bin' });
  assert.equal(result.output.trim(), '/tp/custom/bin');
});

test('run() does not interpret arguments through a shell', async () => {
  const marker = 'taskpilot-shell-canary';
  const config = await workspaceWith({
    // If a shell ran this, the && would start a second command.
    test: { command: process.execPath, args: ['-e', 'console.log(1)', `&& echo ${marker}`] },
  });
  const result = await verification.run(config, 'test');
  assert.ok(!result.output.includes(marker), result.output);
});

test('parseSpec() reads the reporter node --test uses by default', () => {
  const results = checkOutput.parseSpec(['✔ first passes (1.2ms)', '✖ second fails (0.5ms)', '    ✔ nested subtest (0.1ms)'].join('\n'));
  assert.deepEqual(
    results.map((r) => r.name),
    ['first passes', 'second fails'],
  );
  assert.deepEqual(
    results.map((r) => r.passed),
    [true, false],
  );
});

test('parseSpec() does not double-count a failure repeated in the summary', () => {
  const results = checkOutput.parseSpec(['✖ broken (1ms)', '✖ broken'].join('\n'));
  assert.equal(results.length, 1);
});

test('parseResults() picks TAP when present and falls back to spec', () => {
  assert.deepEqual(
    checkOutput.parseResults('ok 1 - tap style').map((r) => r.name),
    ['tap style'],
  );
  assert.deepEqual(
    checkOutput.parseResults('✔ spec style (1ms)').map((r) => r.name),
    ['spec style'],
  );
  assert.deepEqual(checkOutput.parseResults('Build finished.'), []);
});

test('run() parses the default node --test output end to end', async () => {
  const config = await workspaceWith({
    test: { command: process.execPath, args: ['-e', "console.log('✔ it works (1ms)')"] },
  });
  const result = await verification.run(config, 'test');
  assert.equal(result.summary.total, 1);
  assert.equal(result.summary.passed, 1);
});

test('matchAcceptance() verifies a criterion whose test passed', () => {
  const matched = verification.matchAcceptance([{ text: 'login works', test: 'login succeeds' }], [{ name: 'login succeeds', passed: true }]);
  assert.equal(matched[0].verified, true);
  assert.equal(matched[0].manual, false);
});

test('matchAcceptance() leaves a criterion unverified when its test failed or is absent', () => {
  const criteria = [
    { text: 'a', test: 'failing test' },
    { text: 'b', test: 'never ran' },
  ];
  const matched = verification.matchAcceptance(criteria, [{ name: 'failing test', passed: false }]);
  assert.equal(matched[0].verified, false);
  assert.equal(matched[0].missing, false);
  assert.equal(matched[1].verified, false);
  assert.equal(matched[1].missing, true);
});

test('matchAcceptance() marks a criterion without a test as manual, never auto-verified', () => {
  const matched = verification.matchAcceptance([{ text: 'reviewed by hand' }], [{ name: 'x', passed: true }]);
  assert.equal(matched[0].manual, true);
  assert.equal(matched[0].verified, false);
});

test('runStep() reads a fresh JUnit report and ignores a stale one', async () => {
  const root = await fs.realpath(await tempDir('taskpilot-check-'));
  const xml = '<testsuite name="s"><testcase name="a"/><testcase name="b"><failure/></testcase></testsuite>';
  const writer = `require('fs').mkdirSync('out',{recursive:true});require('fs').writeFileSync('out/r.xml',${JSON.stringify(xml)});process.exit(1)`;
  const junit = step({
    commands: [{ command: process.execPath, args: ['-e', writer] }],
    parser: { format: 'junit', path: 'out/r.xml' },
    env: { TP_MARK: '1' },
  });
  const fresh = await verification.runStep(root, junit);
  assert.deepEqual(fresh.report, { format: 'junit', trusted: true, problem: null });
  assert.deepEqual(
    fresh.results.map((r) => [r.fullName, r.passed]),
    [
      ['s › a', true],
      ['s › b', false],
    ],
  );
  assert.equal(fresh.summary.failed, 1);
  assert.deepEqual(fresh.diagnostics, [{ file: null, line: null, column: null, severity: 'error', message: 's › b', rule: null }]);

  // A command that does not rewrite the report leaves the old one behind.
  const stale = await verification.runStep(root, { ...junit, commands: [{ command: process.execPath, args: ['-e', 'process.exit(0)'] }] });
  assert.deepEqual(stale.report, { format: 'junit', trusted: false, problem: 'stale' });
  assert.deepEqual(stale.results, []);
});

test('runStep() passes the step env but never lets it replace PATH', async () => {
  const result = await verification.runStep(
    process.cwd(),
    step({
      commands: [{ command: process.execPath, args: ['-e', 'console.log(process.env.TP_MARK + "|" + process.env.PATH)'] }],
      env: { TP_MARK: 'yes', PATH: '/evil' },
    }),
    { envPath: '/tp/bin' },
  );
  assert.equal(result.output.trim(), 'yes|/tp/bin');
});

test('runStep() turns colour off, including an inherited CARGO_TERM_COLOR', async () => {
  vi.stubEnv('CARGO_TERM_COLOR', 'always');
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  const result = await verification.runStep(
    process.cwd(),
    step({
      commands: [
        { command: process.execPath, args: ['-e', 'console.log([process.env.NO_COLOR, process.env.FORCE_COLOR, process.env.CARGO_TERM_COLOR].join("|"))'] },
      ],
    }),
  );
  assert.equal(result.output.trim(), '1|0|never');
});

test("runStep() runs a step's commands in order and stops at the first failure", async () => {
  const root = await fs.realpath(await tempDir('taskpilot-step-'));
  const node = (code: string) => ({ command: process.execPath, args: ['-e', code] });
  const result = await verification.runStep(
    root,
    step({ commands: [node("console.log('first')"), node('process.exit(4)'), node("console.log('never')")], parser: { format: 'exitcode' } }),
  );
  assert.equal(result.exitCode, 4);
  assert.match(result.output, /first/);
  assert.doesNotMatch(result.output, /never/);
  assert.equal(result.command.split(' && ').length, 3);
  assert.deepEqual(result.report, { format: 'exitcode', trusted: true, problem: null });
});

test("runStep() runs in the step's directory and maps diagnostics back to the repository root", async () => {
  const root = await fs.realpath(await tempDir('taskpilot-step-'));
  await fs.mkdir(path.join(root, 'app'));
  const printer = "console.log(process.cwd().endsWith('app') ? 'src/a.ts:3:7: Bad thing' : 'wrong dir'); process.exit(1)";
  const result = await verification.runStep(
    root,
    step({
      id: 'lint',
      cwd: 'app',
      commands: [{ command: process.execPath, args: ['-e', printer] }],
      parser: { format: 'regex', pattern: '^(?<file>[^:]+):(?<line>\\d+):(?<column>\\d+): (?<message>.+)$', severity: 'error' },
    }),
  );
  assert.deepEqual(result.diagnostics, [{ file: 'app/src/a.ts', line: 3, column: 7, severity: 'error', message: 'Bad thing', rule: null }]);
  assert.deepEqual(
    result.results.map((r) => [r.name, r.passed]),
    [['app/src/a.ts › Bad thing', false]],
  );
});

test('runStep() reads JSON from stdout past a banner, and flags output that is not JSON', async () => {
  const report = JSON.stringify({ diagnostics: [{ file: 'a.ts', line: 1, severity: 'warning', message: 'w' }] });
  const ok = await verification.runStep(
    process.cwd(),
    step({
      commands: [{ command: process.execPath, args: ['-e', `console.log('> banner'); console.log(${JSON.stringify(report)})`] }],
      parser: { format: 'json', dialect: 'diagnostics', path: null },
    }),
  );
  assert.equal(ok.report.trusted, true);
  assert.deepEqual(
    ok.diagnostics.map((d) => [d.file, d.severity]),
    [['a.ts', 'warning']],
  );
  // A warning is listed but is not a failure.
  assert.deepEqual(ok.results, []);
  const bad = await verification.runStep(
    process.cwd(),
    step({ commands: [{ command: process.execPath, args: ['-e', "console.log('nope')"] }], parser: { format: 'json', dialect: 'diagnostics', path: null } }),
  );
  assert.deepEqual(bad.report, { format: 'json', trusted: false, problem: 'invalid' });
});

// A check that reads stdin (here `cat`, like a fake CLI in a test script or a
// prompt) must see end of input and finish, not wait for a keyboard forever.
test('run() closes stdin so a command that reads it finishes', async () => {
  const config = await workspaceWith({
    test: { command: process.execPath, args: ['-e', "process.stdin.resume(); process.stdin.on('end', () => console.log('ok 1 - stdin closed'))"] },
  });
  const result = await verification.run(config, 'test', { timeoutMs: 5000 });
  assert.equal(result.timedOut, false);
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /stdin closed/);
});

test('run() streams output as it arrives', async () => {
  const config = await workspaceWith({ test: { command: process.execPath, args: ['-e', "console.log('first'); console.error('second')"] } });
  const chunks: string[] = [];
  await verification.run(config, 'test', { onOutput: (chunk) => chunks.push(chunk) });
  assert.match(chunks.join(''), /first[\s\S]*second|second[\s\S]*first/);
});
