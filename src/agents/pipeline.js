// Runs Architect's two steps (select files, summarize) for a requirement.
//
// Shared by the app (ipc.js) and the eval harness, so both exercise the same
// code path. Failure here is never fatal to the requirement: Product Lead
// can still plan from the file list, so callers get { summary: null, error }.
const architect = require('./architect');
const { readTracked } = require('../repo-reader');

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

module.exports = { summarizeForRequirement, throwIfCancelled };
