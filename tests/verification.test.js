const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const verification = require('../src/verification');

async function workspaceWith(commands) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskpilot-verify-'));
  test.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, commands };
}

test('parseTap() reads pass, fail, skip, and todo lines', () => {
  const results = verification.parseTap([
    'TAP version 13',
    'ok 1 - first passes',
    'not ok 2 - second fails',
    'ok 3 - third # SKIP not ready',
    'ok 4 - fourth # TODO later',
  ].join('\n'));

  assert.deepEqual(results.map((r) => r.name), ['first passes', 'second fails', 'third', 'fourth']);
  assert.deepEqual(results.map((r) => r.passed), [true, false, true, true]);
  assert.equal(results[2].skipped, true);
  assert.equal(results[3].todo, true);
});

test('parseTap() ignores indented subtest lines so suites are not double-counted', () => {
  const results = verification.parseTap(['    ok 1 - inner', 'ok 1 - outer suite'].join('\n'));
  assert.deepEqual(results.map((r) => r.name), ['outer suite']);
});

test('parseTap() returns nothing for output that is not TAP', () => {
  assert.deepEqual(verification.parseTap('Compiling...\nBuild succeeded in 2s\n'), []);
});

test('summarize() excludes skipped and todo tests from the counts', () => {
  const summary = verification.summarize([
    { passed: true }, { passed: false }, { passed: true, skipped: true },
  ], 1);
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
  assert.deepEqual(result.results.map((r) => r.name), ['it works']);
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
  const results = verification.parseSpec([
    '✔ first passes (1.2ms)',
    '✖ second fails (0.5ms)',
    '    ✔ nested subtest (0.1ms)',
  ].join('\n'));
  assert.deepEqual(results.map((r) => r.name), ['first passes', 'second fails']);
  assert.deepEqual(results.map((r) => r.passed), [true, false]);
});

test('parseSpec() does not double-count a failure repeated in the summary', () => {
  const results = verification.parseSpec(['✖ broken (1ms)', '✖ broken'].join('\n'));
  assert.equal(results.length, 1);
});

test('parseResults() picks TAP when present and falls back to spec', () => {
  assert.deepEqual(verification.parseResults('ok 1 - tap style').map((r) => r.name), ['tap style']);
  assert.deepEqual(verification.parseResults('✔ spec style (1ms)').map((r) => r.name), ['spec style']);
  assert.deepEqual(verification.parseResults('Build finished.'), []);
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
  const matched = verification.matchAcceptance(
    [{ text: 'login works', test: 'login succeeds' }],
    [{ name: 'login succeeds', passed: true }],
  );
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
