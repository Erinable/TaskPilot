// The agents that judge a package: QA reviews a submission, Architect rules
// on a reported deviation, and the baseline measures the submit checks on
// the claimed commit for both to compare against. Each runs in the
// background and moves the package on itself when it finishes.
import { asAgentError, errorCode } from './coded_error.ts';
import * as git from './git.ts';
import * as evidence from './evidence.ts';
import * as verification from './verification.ts';
import { reportIgnore, submitChecks } from './submit_checks.ts';
import { adjudicateDeviation, reviewWorkPackage, throwIfCancelled } from './agents/pipeline.ts';
import { agentTransitionOf, toWireState } from './app_context.ts';
import type { AppContext } from './app_context.ts';
import type { BaselineChecks, BaselineChecksStatus } from './work_package_store.ts';

// Tracked files and HEAD; untracked files (build output) are allowed to appear.
const treeState = async (root: string) => {
  const entries = await git.status(root);
  return {
    head: await git.head(root),
    dirty: entries
      .filter((entry) => !entry.untracked)
      .map((entry) => `${entry.status} ${entry.path}`)
      .sort(),
  };
};

// `onJudged` runs once QA's verdict is recorded: what follows a review
// (grading, the next coding round) belongs to other domains.
export const createReviewService = (ctx: AppContext, { onJudged }: { onJudged: (id: string) => Promise<void> }) => {
  const { store, backgroundRuns, requireTask } = ctx;

  // Starts QA in the background. The renderer polls tasks:get for the
  // outcome; QA moves the package on itself when it finishes.
  const startReview = async (id: string) => {
    const task = requireTask(id);
    const root = ctx.requireRoot();
    const baseline = ctx.requireBaseline(id);
    const reviewRunner = ctx.runnerFor('qa', { kind: 'package', id });
    const entry = await store.beginReview(id);
    // One in-flight review per work package, so it can be cancelled.
    const controller = backgroundRuns.start({ kind: 'review', key: id, busy: 'review', agent: () => 'qa', label: ctx.packageLabel(id) });
    const config = ctx.getConfig();
    const settled = (async () => {
      let outcome: { result: Awaited<ReturnType<typeof reviewWorkPackage>> } | { error: unknown };
      try {
        const { path: envPath } = await ctx.commandPath();
        const steps = await ctx.runnableSteps(config);
        const checks = submitChecks(steps);
        const result = await reviewWorkPackage(task, {
          root,
          baseline,
          runAgent: reviewRunner,
          checks,
          runCheck: (kind: string, signal?: AbortSignal) =>
            // reviewWorkPackage() only asks for the kinds in `checks`.
            verification.runStep(root, (checks.find((check) => check.kind === kind) as (typeof checks)[number]).step, { signal, envPath }),
          baselines: store.get(id).baselineChecks?.checks ?? {},
          ignore: reportIgnore(steps),
          interfaces: ctx.interfacesFor(task),
          envPath,
          signal: controller.signal,
        });
        throwIfCancelled(controller.signal);
        outcome = { result };
      } catch (error) {
        outcome = { error: controller.signal.aborted ? Object.assign(new Error('The review was cancelled'), { code: 'agent_cancelled' }) : error };
      }
      // Drop the run first, so nobody sees a finished review that still
      // looks cancellable.
      backgroundRuns.finish('review', id, controller);
      if ('error' in outcome) await store.failReview(id, asAgentError(outcome.error)).catch(() => {});
      else {
        const before = store.get(id).status;
        await store
          .completeReview(id, outcome.result)
          .then((after) => ctx.recordTransition(id, before, after, agentTransitionOf(before, after.status), 'agent'))
          // Awaited so a repository switch waits for what follows to be recorded.
          .then(() => onJudged(id))
          .catch((error) => store.failReview(id, error).catch(() => {}));
      }
    })();
    backgroundRuns.track(settled);
    return toWireState(entry);
  };

  // Starts Architect's ruling in the background. Like QA, it moves the
  // package on itself: back to the developer, or to the queue with a new plan.
  // Without a workspace it still runs, on the package text alone.
  const startAdjudication = async (id: string) => {
    const task = requireTask(id);
    // Fixed at the start: a repository switch cancels the run, but the code
    // must never be read from the next repository meanwhile.
    const { root } = ctx.getConfig();
    const architectRunner = ctx.runnerFor('architect', { kind: 'package', id });
    const entry = await store.beginAdjudication(id);
    const controller = backgroundRuns.start({ kind: 'adjudication', key: id, busy: 'adjudication', agent: () => 'architect', label: ctx.packageLabel(id) });
    const settled = (async () => {
      let outcome: { result: Awaited<ReturnType<typeof adjudicateDeviation>> } | { error: unknown };
      try {
        const { path: envPath } = await ctx.commandPath();
        const result = await adjudicateDeviation(task, {
          root,
          deviations: entry.deviations,
          // beginAdjudication() has just set it.
          mustReplan: entry.adjudication?.mustReplan === true,
          runAgent: architectRunner,
          interfaces: ctx.interfacesFor(task),
          envPath,
          signal: controller.signal,
        });
        throwIfCancelled(controller.signal);
        outcome = { result };
      } catch (error) {
        outcome = { error: controller.signal.aborted ? Object.assign(new Error('The adjudication was cancelled'), { code: 'agent_cancelled' }) : error };
      }
      backgroundRuns.finish('adjudication', id, controller);
      if ('error' in outcome) await store.failAdjudication(id, asAgentError(outcome.error)).catch(() => {});
      else {
        const before = store.get(id).status;
        await store
          .completeAdjudication(id, outcome.result)
          .then((after) => {
            // A replan drops the reference and grade; stop the runs writing them.
            if (after.status === 'pending') {
              backgroundRuns.get('reference', id)?.abort();
              backgroundRuns.get('grade', id)?.abort();
            }
            return ctx.recordTransition(id, before, after, agentTransitionOf(before, after.status), 'agent');
          })
          .catch((error) => store.failAdjudication(id, error).catch(() => {}));
      }
    })();
    backgroundRuns.track(settled);
    return toWireState(entry);
  };

  // Measures the baseline in the background. It only counts when the tree was
  // clean at the claimed commit before and after: a run over half-edited code
  // would blame or excuse the wrong tests.
  const measureBaseline = async (id: string) => {
    const config = ctx.getConfig();
    const root = config.root;
    const commit = store.get(id).baseline;
    if (!root || !commit) return;
    backgroundRuns.get('baseline', id)?.abort();
    const controller = backgroundRuns.start({ kind: 'baseline', key: id, busy: 'baseline', label: ctx.packageLabel(id) });
    const startedAt = new Date().toISOString();
    const record = (status: BaselineChecksStatus, extra: Partial<BaselineChecks> = {}) =>
      store
        .setBaselineChecks(id, {
          status,
          reason: null,
          commit,
          checks: {},
          startedAt,
          finishedAt: new Date().toISOString(),
          ...extra,
        })
        .catch(() => null);

    const settled = (async () => {
      try {
        // Resolved inside the tracked run, so a switch or shutdown waits for it.
        const checks = submitChecks(await ctx.runnableSteps(config));
        if (!checks.length) return void (await record('unavailable', { reason: 'no_checks' }));
        const before = await treeState(root);
        if (before.head !== commit) return void (await record('unavailable', { reason: 'head_moved' }));
        if (before.dirty.length) return void (await record('unavailable', { reason: 'dirty_tree' }));
        await record('measuring', { finishedAt: null });

        const { path: envPath } = await ctx.commandPath();
        const results: BaselineChecks['checks'] = {};
        for (const check of checks) {
          if (controller.signal.aborted) break;
          try {
            const run = await verification.runStep(root, check.step, { signal: controller.signal, envPath });
            results[check.kind] = evidence.baselineRecord(run, check.line);
          } catch (error) {
            if (controller.signal.aborted) break;
            results[check.kind] = { status: 'unavailable', reason: errorCode(error) ?? 'failed', line: check.line };
          }
        }
        if (controller.signal.aborted) return void (await record('unavailable', { reason: 'cancelled' }));

        const after = await treeState(root);
        const same = after.head === commit && after.dirty.join('\n') === before.dirty.join('\n');
        await record(same ? 'measured' : 'contaminated', same ? { checks: results } : { reason: 'tree_changed' });
      } catch (error) {
        await record('unavailable', { reason: errorCode(error) ?? 'failed' });
      } finally {
        backgroundRuns.finish('baseline', id, controller);
      }
    })();
    backgroundRuns.track(settled);
    return settled;
  };

  return { startReview, startAdjudication, measureBaseline };
};

export type ReviewService = ReturnType<typeof createReviewService>;
