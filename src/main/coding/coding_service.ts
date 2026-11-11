// The Coding Agent loop: a round runs in an isolated workspace, its patch is
// reviewed and applied, the submit checks run on it, and a clean result goes
// to QA. Automatic rounds continue on failing checks or a QA rejection while
// attempts remain (rules in ./coding_loop.ts).
import os from 'node:os';

import { logger } from '../infrastructure/logger.ts';
import { asAgentError, codedError, errorCode, failWith } from '../infrastructure/coded_error.ts';
import * as codingExec from './coding_exec.ts';
import { CODING_USER } from './coding_process.ts';
import * as codingWorkspace from './coding_workspace.ts';
import * as codingLoop from './coding_loop.ts';
import * as evidence from '../checking/evidence.ts';
import * as patchMerge from './patch_merge.ts';
import * as verification from '../checking/verification.ts';
import { billableCodingUsage, codingCancelled, codingFailure } from './coding_runtime.ts';
import { submitChecks } from '../checking/submit_checks.ts';
import { codingCall } from '../runtimes/model_usage.ts';
import type * as codingTypes from '../../shared/coding_types.ts';
import type * as packageTypes from '../../shared/ipc/packages.ts';
import type { AppContext } from '../app/app_context.ts';
import type { CodingRuntime } from './coding_runtime.ts';
import type { RunInfo } from '../app/background_runs.ts';

type CodingServiceContext = Pick<
  AppContext,
  | 'backgroundRuns'
  | 'catalog'
  | 'changed'
  | 'commandPath'
  | 'getConfig'
  | 'getPreferences'
  | 'onCancelAll'
  | 'packageLabel'
  | 'profile'
  | 'record'
  | 'recordCall'
  | 'recordTransition'
  | 'requireBaseline'
  | 'requireRoot'
  | 'requireTask'
  | 'runnableSteps'
  | 'store'
  | 'viewOf'
>;

type ActiveRound = {
  run: codingTypes.CodingRun;
  controller: AbortController;
  events: codingTypes.CodingEvent[];
  workspace: codingWorkspace.PreparedCodingWorkspace;
};

const MAX_CODING_EVENTS = 200;
// A streaming round reports many events a second; the renderer refetches on
// each notification, so they are sent at most this often.
export const EVENT_NOTIFY_MS = 250;

// Calls `notify` at most once per `ms`, at the end of the window (trailing).
// `flush` sends a pending call now; `cancel` drops it.
const trailingThrottle = (notify: () => void, ms: number) => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const fire = () => {
    timer = null;
    notify();
  };
  return {
    call: () => {
      if (!timer) timer = setTimeout(fire, ms);
    },
    flush: () => {
      if (!timer) return;
      clearTimeout(timer);
      fire();
    },
  };
};

// A new round may start once the previous one has finished or handed its
// patch over; ready (unapplied) and in-flight rounds block it.
const CODING_STARTABLE: codingTypes.CodingRunStatus[] = ['failed', 'cancelled', 'discarded', 'applied', 'submitted'];

// `startReview` hands a submitted package to QA.
export const createCodingService = (ctx: CodingServiceContext, runtime: CodingRuntime, { startReview }: { startReview: (id: string) => Promise<unknown> }) => {
  const { store, backgroundRuns, getPreferences, requireTask, requireRoot, record, recordCall } = ctx;

  const activeRounds = new Map<string, ActiveRound>();
  const eventHistory = new Map<string, codingTypes.CodingEvent[]>();
  const checkControllers = new Map<string, { runId: string; controller: AbortController }>();
  ctx.onCancelAll(() => eventHistory.clear());

  const codingRunOf = (id: string) => {
    const task = requireTask(id);
    const run = store.get(id).codingRun;
    if (!run) throw codedError('No coding run exists', 'coding_not_running');
    return { task, run };
  };
  const workspaceOf = (id: string, run: codingTypes.CodingRun) => activeRounds.get(id)?.workspace ?? { runName: run.runName, directory: run.runName };
  const currentRun = (id: string, runId: string) => {
    const state = store.get(id);
    return state.status === 'in_progress' && !!state.baseline && state.mode !== 'practice' && state.codingRun?.id === runId;
  };
  const requireCurrentRun = (id: string, runId: string, statuses?: codingTypes.CodingRunStatus[]) => {
    if (!currentRun(id, runId)) failWith('The coding claim is no longer current', 'coding_aborted');
    const run = store.get(id).codingRun!;
    if (statuses && !statuses.includes(run.status)) failWith('Coding patch is not ready', 'coding_not_ready');
    return run;
  };
  const requireActiveRound = (id: string, runId: string, signal: AbortSignal) => {
    requireCurrentRun(id, runId);
    if (signal.aborted) throw codedError('Coding run was cancelled', 'coding_aborted');
  };
  const updateCoding = async (id: string, runId: string, patch: Partial<codingTypes.CodingRun>) => {
    requireCurrentRun(id, runId);
    const state = await store.updateCodingRun(id, patch, runId);
    requireCurrentRun(id, runId);
    const active = activeRounds.get(id);
    if (active?.run.id === runId) active.run = state.codingRun as codingTypes.CodingRun;
    return state;
  };

  const finishRound = async (id: string, active: ActiveRound, runName: string) => {
    const runId = active.run.id;
    if (currentRun(id, runId)) eventHistory.set(id, [...active.events]);
    else eventHistory.delete(id);
    const current = store.get(id).codingRun;
    if (current?.id !== runId || !['ready', 'applied'].includes(current.status)) await runtime.cleanRun(runName).catch(() => {});
    if (activeRounds.get(id) === active) activeRounds.delete(id);
    backgroundRuns.finish('coding', id, active.controller);
  };

  // How each file of `patch` would merge into the working tree now.
  const previewOf = (run: codingTypes.CodingRun, patch: string) => runtime.previewMerge(requireRoot(), run.baseline, codingWorkspace.filePatches(patch));

  // One coding round. The developer's round starts a chain at attempt 1;
  // automatic rounds continue it with feedback, from the current working tree.
  const startRound = async (
    id: string,
    { instruction, trigger, feedback, expect }: { instruction: string; trigger: codingTypes.CodingTrigger; feedback: string | null; expect?: string },
  ): Promise<packageTypes.TaskView> => {
    if (expect !== undefined) requireCurrentRun(id, expect);
    const runtimeConfig = { ...getPreferences().agents['coding-agent'] };
    const timeoutMinutes = getPreferences().coding.timeoutMinutes;
    const task = requireTask(id);
    const state = store.get(id);
    if (state.status !== 'in_progress') failWith('Coding Agent can only run on an in-progress package', 'invalid_state');
    // A practice package is the developer's exercise; release it to hand it over.
    if (state.mode === 'practice') failWith('This package is being practised; Coding Agent stays out', 'practice_mode');
    // A package the developer writes themselves is handed over first (package:hand-to-ai).
    if (state.mode === 'self') failWith('This package is written by hand; hand it to Coding Agent first', 'self_mode');
    if (activeRounds.has(id) || backgroundRuns.has('coding-checks', id)) failWith('A Coding Agent run is already active', 'coding_running');
    const claim = store.claimIdentity(id);
    const previous = state.codingRun;
    if (previous && !CODING_STARTABLE.includes(previous.status)) failWith('This package already has a Coding Agent result', 'coding_result_exists');
    const root = requireRoot();
    // Fixed at the start, like the root: a switch must not change the prompt.
    const config = ctx.getConfig();
    // The developer's own edits and earlier applied rounds are part of the start.
    const baseline = await runtime.snapshot(root, ctx.requireBaseline(id), task.fileScope);
    const chained = trigger !== 'human' && previous;
    const runId = codingExec.codingRunId();
    const sandbox = await runtime.startSandbox();
    const initial: codingTypes.CodingRun = {
      id: runId,
      packageId: id,
      runName: runtime.runNameFor(sandbox, runId),
      baseline,
      status: 'preparing',
      user: sandbox ? os.userInfo().username : CODING_USER,
      model: runtimeConfig.model,
      cli: runtimeConfig.cli,
      thinking: runtimeConfig.thinking,
      runtimeVersion: null,
      sessionId: null,
      instruction,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      error: null,
      output: '',
      usage: { inputTokens: null, outputTokens: null, cachedInputTokens: null, reasoningTokens: null, costUsd: null },
      files: [],
      blocked: [],
      checks: {},
      patchDigest: null,
      attempt: chained ? previous.attempt + 1 : 1,
      trigger,
      feedback,
      halt: null,
      rounds: chained ? [...previous.rounds, codingLoop.roundOf(previous)] : [],
    };
    if (store.get(id).codingRun?.id !== previous?.id) failWith('The coding round was replaced while preparing', 'coding_aborted');
    await store.setCodingRun(id, initial, claim);
    requireCurrentRun(id, runId);
    record({ kind: 'coding_run', packageId: id, title: task.title, status: 'started', costUsd: null });
    const timeoutPatch = async (error: unknown, prepared: codingWorkspace.PreparedCodingWorkspace | null, cancelled: boolean) => {
      if (cancelled || !prepared || errorCode(error) !== 'coding_timeout') return undefined;
      return runtime.readPatch(prepared.runName, task.fileScope, { sandbox, cli: runtimeConfig.cli }).catch((failure) => void logger.error(failure));
    };
    const info: RunInfo = { kind: 'coding', key: id, busy: 'coding', agent: () => 'coding-agent', label: ctx.packageLabel(id) };
    void backgroundRuns.run(info, async (controller) => {
      const active: ActiveRound = {
        run: initial,
        controller,
        events: [],
        workspace: { runName: initial.runName, directory: initial.runName },
      };
      activeRounds.set(id, active);
      eventHistory.set(id, []);
      const eventsChanged = trailingThrottle(() => ctx.changed('coding', 'activity'), EVENT_NOTIFY_MS);
      let prepared: codingWorkspace.PreparedCodingWorkspace | null = null;
      try {
        prepared = await runtime.prepare(root, baseline, { runName: initial.runName, signal: controller.signal, sandbox, cli: runtimeConfig.cli });
        requireActiveRound(id, runId, controller.signal);
        active.workspace = prepared;
        await updateCoding(id, runId, { status: 'running' });
        const profile = await ctx.profile(config);
        requireActiveRound(id, runId, controller.signal);
        const result = await runtime.run({
          runName: prepared.runName,
          config: runtimeConfig,
          prompt: runtime.codingPrompt(task, instruction, feedback, profile),
          timeoutMs: timeoutMinutes * 60 * 1000,
          signal: controller.signal,
          sandbox,
          onEvent: (event) => {
            active.events.push(event);
            if (active.events.length > MAX_CODING_EVENTS) active.events = active.events.slice(-MAX_CODING_EVENTS);
            eventsChanged.call();
          },
        });
        recordCall('coding-agent', codingCall(runtimeConfig.cli, runtimeConfig.model, result.usage), { kind: 'package', id });
        requireActiveRound(id, runId, controller.signal);
        eventsChanged.flush();
        active.events = result.events.map((event, sequence) => ({ ...event, sequence })).slice(-MAX_CODING_EVENTS);
        eventHistory.set(id, [...active.events]);
        await updateCoding(id, runId, { status: 'checking', output: result.output, usage: result.usage, sessionId: result.sessionId });
        ctx.changed('activity');
        const preview = await runtime.readPatch(prepared.runName, task.fileScope, { signal: controller.signal, sandbox, cli: runtimeConfig.cli });
        // An empty automatic round never has a reviewable patch. Publish its
        // terminal state before cleanup, so observers cannot open its directory
        // in the short interval between ready and discarded.
        await updateCoding(id, runId, {
          ...codingLoop.patchState(trigger, preview),
          finishedAt: new Date().toISOString(),
          files: preview.files,
          blocked: preview.blocked,
          patchDigest: preview.digest,
        });
        record({ kind: 'coding_run', packageId: id, title: task.title, status: 'finished', costUsd: result.usage.costUsd });
      } catch (error) {
        const cancelled = codingCancelled(error, controller.signal);
        // A failed, timed-out or cancelled round can still have been billed.
        const spent = billableCodingUsage(error);
        if (spent) {
          recordCall('coding-agent', codingCall(runtimeConfig.cli, runtimeConfig.model, spent), { kind: 'package', id });
          if (currentRun(id, runId)) await updateCoding(id, runId, { usage: spent }).catch(() => {});
        }
        // A timed-out round keeps what it wrote so far for the developer to
        // review; it is never applied automatically.
        if (!currentRun(id, runId)) return;
        const partial = await timeoutPatch(error, prepared, cancelled);
        if (partial?.files.length) {
          await updateCoding(id, runId, {
            status: 'ready',
            finishedAt: new Date().toISOString(),
            error: codingFailure(error),
            halt: 'timed_out',
            files: partial.files,
            blocked: partial.blocked,
            patchDigest: partial.digest,
          }).catch(() => {});
          ctx.changed('activity');
          record({ kind: 'coding_run', packageId: id, title: task.title, status: 'failed', costUsd: spent?.costUsd ?? null });
          return;
        }
        await updateCoding(id, runId, {
          status: cancelled ? 'cancelled' : 'failed',
          finishedAt: new Date().toISOString(),
          error: codingFailure(error),
        }).catch(() => {});
        record({ kind: 'coding_run', packageId: id, title: task.title, status: cancelled ? 'cancelled' : 'failed', costUsd: spent?.costUsd ?? null });
      } finally {
        eventsChanged.flush();
        await finishRound(id, active, prepared?.runName ?? initial.runName);
      }
      // Automatic rounds go on by themselves; the developer's round waits for
      // a per-file review.
      const settledRun = store.get(id).codingRun;
      if (trigger !== 'human' && currentRun(id, runId) && settledRun?.status === 'ready' && !settledRun.halt)
        continueLoop(id, runId, () => autoApplyRound(id, runId));
    });
    return ctx.viewOf(task, store.get(id));
  };

  // An automatic round's patch: applied whole unless it touches a high-risk
  // path, which stops the loop for the developer.
  const autoApplyRound = async (id: string, runId: string) => {
    const { task } = codingRunOf(id);
    const run = requireCurrentRun(id, runId, ['ready']);
    const preview = await runtime.readRunPatch(run.runName, task.fileScope);
    const decision = codingLoop.autoApply(preview);
    if (decision.highRisk) return void (await updateCoding(id, runId, { halt: 'high_risk' }));
    // Changes that were all refused are not "no changes": keep the round so
    // the developer sees which files and why.
    if (!decision.files.length && preview.blocked.length) return void (await updateCoding(id, runId, { halt: 'blocked' }));
    if (!decision.files.length) {
      await updateCoding(id, runId, { status: 'discarded', halt: 'no_changes' });
      return void (await runtime.cleanRun(run.runName).catch((error) => logger.error(error)));
    }
    // The developer edited the same lines meanwhile: never overwrite, ask.
    const merge = await previewOf(run, preview.patch);
    if (merge.some((file) => file.state === 'conflict')) return void (await updateCoding(id, runId, { halt: 'conflict' }));
    await applyRound(id, runId, preview, decision.files, false, {});
    if (requireCurrentRun(id, runId).status === 'verifying') await verifyApplied(id, runId);
  };

  // Applies the chosen files of a ready patch to the working tree.
  const applyRound = async (
    id: string,
    runId: string,
    preview: codingTypes.CodingPatchPreview,
    files: string[],
    allowHighRisk: boolean,
    resolutions: Partial<Record<string, codingTypes.CodingResolution>>,
  ): Promise<codingTypes.CodingApplyResult> => {
    const { task } = codingRunOf(id);
    const rules = await runtime.patchRules();
    const run = requireCurrentRun(id, runId, ['ready']);
    const selected = codingWorkspace.parsePatchPreview(codingWorkspace.selectPatch(preview.patch, files), task.fileScope, rules);
    const blocked = allowHighRisk ? selected.blocked.filter((entry) => entry.reason !== 'high-risk project control or test path') : selected.blocked;
    await updateCoding(id, runId, { status: 'applying', error: null });
    try {
      requireCurrentRun(id, runId, ['applying']);
      const applied = await runtime.applyPatch(requireRoot(), selected.patch, selected.digest, blocked, {
        baseline: run.baseline,
        resolutions,
        rules,
        assertCurrent: () => void requireCurrentRun(id, runId, ['applying']),
      });
      // An infrastructure package can add dev dependencies. They were installed
      // in the isolated copy, not this checkout: wait for a human to install
      // locally before interpreting missing tools as code failures.
      const needsSetup =
        Boolean(task.environment) && selected.files.some((file) => ['package.json', 'package-lock.json', 'npm-shrinkwrap.json'].includes(file.path));
      await updateCoding(id, runId, {
        status: applied.markers.length || needsSetup ? 'applied' : 'verifying',
        halt: applied.markers.length ? 'markers' : needsSetup ? 'setup_required' : null,
        finishedAt: new Date().toISOString(),
        files: selected.files,
        blocked: preview.blocked,
        patchDigest: selected.digest,
      });
      await runtime.cleanRun(run.runName).catch((error) => logger.error(error));
      return { files: applied.written, markers: applied.markers, kept: applied.kept };
    } catch (error) {
      if (currentRun(id, runId)) await updateCoding(id, runId, { status: 'ready', error: codingFailure(error) });
      throw error;
    }
  };

  // Runs the submit checks on the applied patch with the developer's
  // permissions. A clean run hands the package to QA; a blocking failure
  // starts the next round while attempts remain.
  const verifyApplied = async (id: string, runId: string) => {
    requireCurrentRun(id, runId, ['verifying']);
    const config = ctx.getConfig();
    const baselines = store.get(id).baselineChecks?.checks ?? {};
    const failures: Parameters<typeof codingLoop.checksFeedback>[0] = [];
    const runs: codingTypes.CodingRun['checks'] = {};
    // Submit checks running on an applied patch, per package.
    const stopped = await backgroundRuns.run({ kind: 'coding-checks', key: id, busy: 'coding', label: ctx.packageLabel(id) }, async (controller) => {
      checkControllers.set(id, { runId, controller });
      try {
        const steps = await ctx.runnableSteps(config);
        const { path: envPath } = await ctx.commandPath();
        for (const check of submitChecks(steps)) {
          if (controller.signal.aborted || !currentRun(id, runId)) break;
          let outcome: Parameters<typeof evidence.evaluate>[1];
          try {
            const run = await verification.runStep(config.root, check.step, { signal: controller.signal, envPath });
            // runStep() echoes the step id it ran.
            runs[check.kind] = { ...run, kind: check.kind };
            outcome = run;
          } catch (error) {
            outcome = { error: { code: errorCode(error) ?? 'not_run', message: error instanceof Error ? error.message : String(error) } };
          }
          const item = evidence.evaluate(check, outcome, evidence.usableBaseline(baselines[check.kind], check.line));
          if (item.status === 'fail' && check.blocking) failures.push({ evidence: item, run: runs[check.kind] ?? null });
        }
        return controller.signal.aborted || !currentRun(id, runId);
      } finally {
        if (checkControllers.get(id)?.controller === controller) checkControllers.delete(id);
      }
    });
    if (!currentRun(id, runId)) return;
    if (stopped) return void (await updateCoding(id, runId, { status: 'applied', checks: runs, halt: 'stopped' }));
    const run = (await updateCoding(id, runId, { checks: runs })).codingRun as codingTypes.CodingRun;
    if (failures.length) {
      if (!codingLoop.canRetry(run)) return void (await updateCoding(id, runId, { status: 'applied', halt: 'attempts_exhausted' }));
      await updateCoding(id, runId, { status: 'applied' });
      await startRound(id, { instruction: run.instruction, trigger: 'checks_failed', feedback: codingLoop.checksFeedback(failures), expect: runId });
      return;
    }
    await updateCoding(id, runId, { status: 'submitted' });
    requireCurrentRun(id, runId, ['submitted']);
    const before = store.get(id).status;
    const entry = await store.transition(id, 'coding_submitted', 'coding-agent');
    ctx.recordTransition(id, before, entry, 'coding_submitted', 'coding-agent');
    await startReview(id).catch(async (error) => {
      logger.error(error);
      await store.failReview(id, asAgentError(error)).catch((failure) => logger.error(failure));
    });
  };

  // Runs one automatic step of the loop in the background. A failure stops
  // the loop with the error on the run, never silently.
  const continueLoop = (id: string, runId: string, step: () => Promise<void>) =>
    backgroundRuns.track(
      step().catch(async (error) => {
        if (!currentRun(id, runId)) return;
        logger.error(error);
        await updateCoding(id, runId, { halt: 'stopped', error: codingFailure(error) }).catch(() => {});
      }),
    );

  // After QA sends a Coding Agent submission back, the next round takes its
  // issues while attempts remain. Runs in the background.
  const continueAfterReview = (id: string) => {
    const runId = store.get(id).codingRun?.id;
    if (!runId) return;
    continueLoop(id, runId, async () => {
      const state = store.get(id);
      const run = state.codingRun;
      if (state.status !== 'in_progress' || run?.status !== 'submitted' || state.review?.status !== 'rejected') return;
      if (!codingLoop.canRetry(run)) return void (await updateCoding(id, runId, { halt: 'attempts_exhausted' }));
      const { reasons = [], report = null, checks = [] } = state.review;
      const feedback = codingLoop.reviewFeedback({ reasons, report: report as packageTypes.QaReport | null, checks });
      await startRound(id, { instruction: run.instruction, trigger: 'qa_rejected', feedback, expect: runId });
    });
  };

  // The developer's round.
  const start = (id: string, instruction: string) => startRound(id, { instruction, trigger: 'human', feedback: null });

  // A page of the round's events after sequence `after`.
  const events = (id: string, after: number): codingTypes.CodingEventPage => {
    const all = activeRounds.get(id)?.events ?? eventHistory.get(id) ?? [];
    const page = all.filter((event) => event.sequence > after).slice(0, 200);
    const next = page.at(-1)?.sequence ?? after;
    return { events: page, next, truncated: page.length > 0 && all.some((event) => event.sequence > next) };
  };

  // Stops the checks or the round in flight, or discards a ready patch.
  const cancel = async (id: string): Promise<boolean> => {
    const active = activeRounds.get(id);
    const verifying = backgroundRuns.get('coding-checks', id);
    if (verifying) {
      verifying.abort();
      return true;
    }
    if (!active) {
      const run = store.get(id).codingRun;
      if (!run || run.status !== 'ready') return false;
      await runtime.cleanRun(run.runName).catch(() => {});
      await updateCoding(id, run.id, { status: 'discarded', finishedAt: new Date().toISOString(), halt: run.trigger === 'human' ? null : 'stopped' });
      return true;
    }
    active.controller.abort();
    if (active.run.trigger !== 'human') await updateCoding(id, active.run.id, { halt: 'stopped' }).catch((error) => logger.error(error));
    return true;
  };

  // The store has already invalidated the claim. Running work owns its final
  // cleanup; a settled patch is removed here and cannot be inherited on claim.
  const release = async (id: string, run: codingTypes.CodingRun | null): Promise<void> => {
    if (!run) return;
    const active = activeRounds.get(id);
    if (active?.run.id === run.id) active.controller.abort();
    const checks = checkControllers.get(id);
    if (checks?.runId === run.id) checks.controller.abort();
    eventHistory.delete(id);
    if (active?.run.id !== run.id) await runtime.cleanRun(run.runName).catch((error) => logger.error(error));
  };

  // The packages with a round or its checks in flight. Read from memory.
  const activeRuns = (): codingTypes.CodingActiveRun[] =>
    [...new Set([...backgroundRuns.keys('coding'), ...backgroundRuns.keys('coding-checks')])].map((packageId) => ({
      packageId,
      title: ctx.catalog.getTask(packageId)?.title ?? packageId,
    }));

  // Only a ready round retains a patch directory. Applied and discarded
  // rounds have already been cleaned; their files are in the host diff/history.
  const patch = async (id: string): Promise<codingTypes.CodingPatchPreview> => {
    const { task, run } = codingRunOf(id);
    const assertReadable = () => {
      const current = requireCurrentRun(id, run.id, ['ready']);
      if (current.trigger !== 'human' && !current.halt) failWith('The automatic round is still applying its patch', 'coding_not_ready');
    };
    assertReadable();
    let preview: codingTypes.CodingPatchPreview;
    try {
      preview = await runtime.readRunPatch(workspaceOf(id, run).runName, task.fileScope);
    } catch (error) {
      // Cleanup may have won a race while the read was in flight. Report the
      // changed lifecycle, not an alarming workspace error for a deleted folder.
      assertReadable();
      throw error;
    }
    assertReadable();
    const merge = await previewOf(run, preview.patch);
    assertReadable();
    return { ...preview, merge, mergeDigest: patchMerge.mergeDigest(preview.patch, merge) };
  };

  // Applies the files the developer reviewed, then goes on with the checks.
  const apply = async (
    id: string,
    {
      digest,
      allowHighRisk,
      files,
      resolutions,
    }: { digest: string; allowHighRisk: boolean; files: string[]; resolutions: Partial<Record<string, codingTypes.CodingResolution>> },
  ): Promise<codingTypes.CodingApplyResult> => {
    const { task, run } = codingRunOf(id);
    if (run.status !== 'ready') failWith('Coding patch is not ready to apply', 'coding_not_ready');
    requireCurrentRun(id, run.id);
    const preview = await runtime.readRunPatch(workspaceOf(id, run).runName, task.fileScope);
    // The digest covers the patch and how it merges now: an edit to a
    // patched file since the developer looked sends them back to look again.
    const merge = await previewOf(run, preview.patch);
    if (patchMerge.mergeDigest(preview.patch, merge) !== digest) failWith('Patch or working tree changed since preview', 'coding_digest_mismatch');
    const selected = new Set(files);
    const unresolved = merge.find((file) => file.state === 'conflict' && selected.has(file.path) && !resolutions[file.path]);
    if (unresolved) failWith(`Choose how to resolve ${unresolved.path}`, 'merge_unresolved', 'resolutions');
    // The round's "finished" was recorded when it produced the patch.
    const applied = await applyRound(id, run.id, preview, files, allowHighRisk, resolutions);
    activeRounds.delete(id);
    // Conflict markers left in a file hold the checks until they are cleared.
    if (requireCurrentRun(id, run.id).status === 'verifying') continueLoop(id, run.id, () => verifyApplied(id, run.id));
    return applied;
  };

  // After the developer cleared the conflict markers an apply left, the
  // automatic flow goes on: checks, then QA. Refused while a marker remains.
  const resume = async (id: string): Promise<packageTypes.TaskView> => {
    const { task, run } = codingRunOf(id);
    requireCurrentRun(id, run.id);
    if (run.status !== 'applied' || !['markers', 'setup_required'].includes(run.halt ?? ''))
      failWith('Nothing is waiting to resume checks', 'coding_not_ready');
    const left = await patchMerge.filesWithMarkers(
      requireRoot(),
      run.files.map((file) => file.path),
    );
    if (left.length) failWith(`Conflict markers remain in ${left.join(', ')}`, 'merge_markers_left');
    requireCurrentRun(id, run.id, ['applied']);
    const needsSetup =
      run.halt === 'markers' &&
      Boolean(task.environment) &&
      run.files.some((file) => ['package.json', 'package-lock.json', 'npm-shrinkwrap.json'].includes(file.path));
    if (needsSetup) {
      await updateCoding(id, run.id, { halt: 'setup_required' });
      return ctx.viewOf(task, store.get(id));
    }
    await updateCoding(id, run.id, { status: 'verifying', halt: null });
    continueLoop(id, run.id, () => verifyApplied(id, run.id));
    return ctx.viewOf(task, store.get(id));
  };

  return { codingRunOf, start, continueAfterReview, events, cancel, release, activeRuns, patch, apply, resume };
};

export type CodingService = ReturnType<typeof createCodingService>;
