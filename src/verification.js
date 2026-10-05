// Runs the workspace's configured verification commands and turns their output
// into structured results the execution page can show.
//
// SECURITY: the command comes from the workspace config only (see
// ./workspace.js), runs through execFile with an argument array, and never
// touches a shell.
const { execFile } = require('node:child_process');
const testReport = require('./test-report');

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_BUFFER = 20 * 1024 * 1024;

class VerificationError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'VerificationError';
    this.code = code;
  }
}

/**
 * Parses TAP 13/14 result lines, which is what `node --test` emits.
 * Subtests are indented; only top-level lines are collected so a suite does
 * not double-count. Returns [] for output that isn't TAP.
 */
function parseTap(output) {
  const results = [];
  for (const line of output.split('\n')) {
    if (/^\s/.test(line)) continue; // subtest
    const match = /^(not ok|ok)\s+(\d+)\s*-?\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, verdict, , rest] = match;
    const name = rest.replace(/\s+#\s*(SKIP|TODO).*$/i, '').trim();
    const directive = /#\s*SKIP/i.test(rest) ? 'skip' : /#\s*TODO/i.test(rest) ? 'todo' : null;
    results.push({
      name,
      passed: verdict === 'ok',
      skipped: directive === 'skip',
      todo: directive === 'todo',
    });
  }
  return results;
}

// Node 22 switched `node --test` from TAP to its "spec" reporter, which marks
// results with ✔/✖ and indents nested tests. Many other runners (vitest, jest)
// print a similar shape, so this covers the common default case too.
const SPEC_LINE = /^(?<mark>[✔✖✗×])\s+(?<name>.+?)(?:\s+\((?<ms>[\d.]+)ms\))?\s*$/;

function parseSpec(output) {
  const results = [];
  for (const line of output.split('\n')) {
    if (/^\s/.test(line)) continue; // nested test
    const match = SPEC_LINE.exec(line.trim() === line ? line : line);
    if (!match) continue;
    const name = match.groups.name.trim();
    // The spec reporter repeats failures in a trailing summary block; those
    // lines have no duration, so skip a name already recorded.
    if (results.some((r) => r.name === name)) continue;
    results.push({ name, passed: match.groups.mark === '✔', skipped: false, todo: false });
  }
  return results;
}

/** Picks the parser that matches the output, preferring TAP when both appear. */
function parseResults(output) {
  const tap = parseTap(output);
  return tap.length > 0 ? tap : parseSpec(output);
}

function summarize(results, exitCode) {
  const counted = results.filter((r) => !r.skipped && !r.todo);
  return {
    total: counted.length,
    passed: counted.filter((r) => r.passed).length,
    failed: counted.filter((r) => !r.passed).length,
    skipped: results.length - counted.length,
    // Exit code is the source of truth: a runner can fail to start and emit
    // no TAP at all, which must not read as "nothing failed".
    ok: exitCode === 0,
  };
}

function spawn(command, args, options) {
  return new Promise((resolve) => {
    const child = execFile(command, args, options, (error, stdout, stderr) => {
      resolve({ error, stdout, stderr });
    });
    options.onSpawn?.(child);
  });
}

/** Runs {command, args} in the workspace; shared by run() and runCheck(). */
async function execute(root, entry, kind, { signal, timeoutMs, envPath, env = {} }) {
  const startedAt = Date.now();
  const { error, stdout, stderr } = await spawn(entry.command, entry.args, {
    cwd: root,
    maxBuffer: MAX_BUFFER,
    timeout: timeoutMs,
    signal,
    // A test runner that inherits a TTY may emit colour codes; ask it not to.
    // envPath (from ./shell-env.js) overrides the inherited PATH, which is
    // minimal when the app is launched from Finder rather than a terminal.
    // `env` is the check's own variables, validated in workspace.js.
    env: { ...process.env, ...env, ...(envPath ? { PATH: envPath } : {}), NO_COLOR: '1', FORCE_COLOR: '0' },
  });

  if (error?.code === 'ENOENT') {
    throw new VerificationError(`Executable not found: ${entry.command}`, 'command_missing');
  }
  if (error?.name === 'AbortError') throw error;

  const output = `${stdout}${stderr}`;
  const timedOut = error?.killed === true && error?.signal === 'SIGTERM';
  // execFile reports a non-zero exit through error.code (a number).
  const exitCode = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
  return {
    kind,
    command: `${entry.command} ${entry.args.join(' ')}`.trim(),
    exitCode,
    timedOut,
    durationMs: Date.now() - startedAt,
    output,
  };
}

function requireEntry(config, kind) {
  const entry = config.checks?.[kind] ?? config.commands?.[kind];
  if (!entry) throw new VerificationError(`No ${kind} command is configured`, 'not_configured');
  if (!config.root) throw new VerificationError('No workspace root is configured', 'no_workspace');
  return entry;
}

/**
 * Executes one verification command and parses its stdout.
 * @returns {Promise<{kind, command, exitCode, timedOut, durationMs, output, results, summary}>}
 */
async function run(config, kind, { signal, timeoutMs = DEFAULT_TIMEOUT_MS, envPath } = {}) {
  const entry = requireEntry(config, kind);
  const outcome = await execute(config.root, entry, kind, { signal, timeoutMs, envPath, env: entry.env });
  const results = parseResults(outcome.output);
  return { ...outcome, results, summary: summarize(results, outcome.exitCode) };
}

/**
 * Executes a configured check and reads its results from the report it is
 * configured with. Results always carry `fullName`, the key baselines use.
 * @returns run() result plus `report: {format, trusted, problem}`; for an
 *   untrusted JUnit report `results` is empty.
 */
async function runCheck(config, kind, { signal, timeoutMs, envPath } = {}) {
  const check = requireEntry(config, kind);
  const report = check.report ?? { format: 'stdout' };
  const before = report.format === 'junit' ? await testReport.statReport(config.root, report.path) : null;
  const outcome = await execute(config.root, check, kind, {
    signal, timeoutMs: timeoutMs ?? check.timeoutMs ?? DEFAULT_TIMEOUT_MS, envPath, env: check.env,
  });
  let results;
  let reportInfo;
  if (report.format === 'junit') {
    const read = await testReport.readReport(config.root, report, before);
    results = read.results;
    reportInfo = { format: 'junit', trusted: read.trusted, problem: read.problem };
  } else {
    results = parseResults(outcome.output).map((r) => ({ ...r, fullName: r.fullName ?? r.name }));
    reportInfo = { format: 'stdout', trusted: true, problem: null };
  }
  return { ...outcome, results, summary: summarize(results, outcome.exitCode), report: reportInfo, check: { stage: check.stage, blocking: check.blocking } };
}

/**
 * Pairs acceptance criteria with test results. A criterion carrying a `test`
 * name is satisfied only when a matching test passed; one without stays
 * manual, so a package can never auto-accept on criteria nobody checked.
 */
function matchAcceptance(criteria, results) {
  const byName = new Map();
  for (const r of results) {
    if (!byName.has(r.name)) byName.set(r.name, r);
    if (r.fullName) byName.set(r.fullName, r);
  }
  return criteria.map((criterion) => {
    if (!criterion.test) return { ...criterion, verified: false, manual: true };
    const result = byName.get(criterion.test);
    return {
      ...criterion,
      verified: result?.passed === true,
      manual: false,
      missing: result === undefined,
    };
  });
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  runCheck,
  VerificationError,
  parseTap,
  parseSpec,
  parseResults,
  summarize,
  run,
  matchAcceptance,
};
