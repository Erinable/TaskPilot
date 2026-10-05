// Runs Architect's two steps (select files, summarize) for a requirement,
// and QA's review of a submitted work package.
//
// Shared by the app (ipc.js) and the eval harness, so both exercise the same
// code path. Failure here is never fatal to the requirement: Product Lead
// can still plan from the file list, so callers get { summary: null, error }.
const architect = require('./architect');
const qa = require('./qa');
const envSteward = require('./env-steward');
const envSetup = require('../env-setup');
const { readTracked } = require('../repo-reader');
const { collectChanges } = require('../review-diff');
const evidence = require('../evidence');
const { checkFileScope } = require('../tasks');

/** Stops between steps when the run was cancelled, whatever the runner does. */
function throwIfCancelled(signal) {
  if (signal?.aborted) throw Object.assign(new Error('Agent run was cancelled'), { code: 'agent_cancelled' });
}

/**
 * @param deps.runAgent  claude-cli.runStructured or a stand-in
 * @param deps.root      repository root, or null when none is configured
 * @param deps.files     tracked file list (already capped)
 * @param deps.readFiles optional (root, paths) => {files, skipped}, for tests
 * @returns {{summary, text, read, skipped, costUsd, error}}
 */
async function summarizeForRequirement({ title, text }, { runAgent, root, files, envPath, signal, readFiles = readTracked }) {
  const empty = { summary: null, text: null, read: [], skipped: [], costUsd: 0, error: null };
  if (!root || files.length === 0) return empty;
  let costUsd = 0;
  try {
    throwIfCancelled(signal);
    const selected = await runAgent({
      prompt: architect.selectPrompt({ title, text, files }),
      systemPrompt: architect.SYSTEM_PROMPT,
      schema: architect.SELECT_SCHEMA,
      envPath,
      signal,
    });
    costUsd += selected.costUsd ?? 0;
    const paths = architect.validateSelection(selected.output, files);
    if (paths.length === 0) return { ...empty, costUsd };

    const { files: sources, skipped } = await readFiles(root, paths);
    if (sources.length === 0) return { ...empty, skipped, costUsd };

    throwIfCancelled(signal);
    const summarized = await runAgent({
      prompt: architect.summarizePrompt({ title, text, files, sources, skipped }),
      systemPrompt: architect.SYSTEM_PROMPT,
      schema: architect.SUMMARY_SCHEMA,
      envPath,
      signal,
    });
    costUsd += summarized.costUsd ?? 0;
    const summary = architect.validateSummary(summarized.output, { readPaths: sources.map((s) => s.path), files });
    return {
      summary,
      text: architect.formatSummary(summary),
      // Path and blob sha of each file read, so a cached summary can be
      // checked against the current index.
      read: sources.map((s) => ({ path: s.path, sha: s.sha })),
      skipped,
      costUsd,
      error: null,
    };
  } catch (error) {
    // Cancellation must stop the whole run, not degrade to a plan without
    // a summary.
    if (error.code === 'agent_cancelled') throw error;
    return { ...empty, costUsd, error: { code: error.code ?? 'agent_failed', message: error.message } };
  }
}

/**
 * Runs QA's review of a submitted work package: the submit-stage checks, the
 * diff since the baseline, then the model. When the outcome is already
 * certain (nothing changed, or a blocking check failed) the model is not
 * called; there is nothing it could add, and it would only cost money.
 *
 * @param task work package definition
 * @param deps.checks    [{kind, stage, blocking, line}] submit-stage checks
 * @param deps.runCheck  (kind, signal) => verification.runCheck() result.
 *   not_configured skips the check; any other error is thrown.
 * @param deps.baselines {kind: evidence.baselineRecord()} measured at claim
 * @param deps.ignore    (path) => true for files the checks wrote
 * @param deps.runAgent  claude-cli.runStructured or a stand-in
 * @param deps.collect   optional review-diff.collectChanges, for tests
 * @param deps.interfaces Architect's formatted summary, or null
 * @returns {{passed, reasons, evidence, attention, checks, verification, acceptance, report, diff, costUsd}}
 */
async function reviewWorkPackage(task, {
  root, baseline, runAgent, checks = [], runCheck, baselines = {}, ignore,
  collect = collectChanges, interfaces = null, envPath, signal,
}) {
  throwIfCancelled(signal);
  const runs = {};
  for (const check of checks) {
    try {
      runs[check.kind] = await runCheck(check.kind, signal);
    } catch (error) {
      // Removed from the config since the review started: nothing to judge.
      // Anything else (a missing executable, say) fails the review so the
      // environment gets fixed and the review retried.
      if (error.code !== 'not_configured') throw error;
    }
    throwIfCancelled(signal);
  }
  const ran = checks.filter((check) => runs[check.kind]);
  const items = ran.map((check) => evidence.evaluate(check, runs[check.kind], evidence.usableBaseline(baselines[check.kind], check.line)));
  const acceptance = evidence.criteriaStatus(task.acceptance ?? [], runs, items, baselines);
  const paired = ran.map((check, index) => ({ evidence: items[index], run: runs[check.kind] }));

  const scope = new Set(task.fileScope ?? []);
  const collected = await collect(root, baseline, { prioritize: (p) => scope.has(p), ...(ignore ? { ignore } : {}) });
  const changedPaths = collected.changes.map((c) => c.path);
  const diff = {
    files: collected.files.map((f) => ({ path: f.path, bytes: f.bytes, untracked: f.untracked })),
    skipped: collected.skipped,
    outOfScope: checkFileScope(task, changedPaths).outOfScope,
  };
  const result = (report, costUsd) => {
    const reasons = qa.decide({ evidence: items, acceptance, changeCount: changedPaths.length, report });
    return {
      passed: reasons.length === 0,
      reasons,
      evidence: items,
      attention: evidence.attention(items, acceptance),
      checks: paired.map(({ evidence: e, run }) => ({ ...e, run: qa.compactRun(run) })),
      verification: qa.compactRun(runs.test ?? null),
      acceptance,
      report,
      diff,
      costUsd,
    };
  };

  const settled = result(null, 0);
  if (settled.reasons.includes('no_changes') || settled.reasons.includes('tests_failed')) return settled;

  throwIfCancelled(signal);
  const { output, costUsd } = await runAgent({
    prompt: qa.reviewPrompt({ task, acceptance, checks: paired, diff: { ...diff, files: collected.files }, interfaces }),
    systemPrompt: qa.SYSTEM_PROMPT,
    schema: qa.REVIEW_SCHEMA,
    envPath,
    signal,
  });
  const report = qa.validateReview(output, { criteriaCount: acceptance.length, changedPaths });
  return result(report, costUsd ?? 0);
}

/**
 * Environment Steward's turn: probe the workspace, then ask the model to pick
 * an install mode and verification scripts. Without a usable package.json
 * there is nothing to choose, so the model is not called.
 *
 * @param deps.failure optional failed step ({step, command, exitCode, timedOut, output})
 * @returns {{facts, blockers, plan, costUsd}}
 */
async function planEnvironment({ root, runAgent, envPath, signal, failure = null, probe = envSetup.probe }) {
  const facts = await probe(root, { envPath });
  const found = envSetup.blockers(facts);
  if (found.includes('no_manifest') || found.includes('invalid_manifest')) {
    return { facts, blockers: found, plan: null, costUsd: 0 };
  }
  throwIfCancelled(signal);
  const { output, costUsd } = await runAgent({
    prompt: envSteward.planPrompt(facts, { failure }),
    systemPrompt: envSteward.SYSTEM_PROMPT,
    schema: envSteward.PLAN_SCHEMA,
    envPath,
    signal,
  });
  return { facts, blockers: found, plan: envSteward.validatePlan(output, facts), costUsd: costUsd ?? 0 };
}

module.exports = { summarizeForRequirement, reviewWorkPackage, planEnvironment, throwIfCancelled };
