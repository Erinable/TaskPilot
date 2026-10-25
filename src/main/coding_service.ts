// The Coding Agent loop: a round runs in an isolated workspace, its patch is
// reviewed and applied, the submit checks run on it, and a clean result goes
// to QA. Automatic rounds continue on failing checks or a QA rejection while
// attempts remain (rules in ./coding_loop.ts).
import os from 'node:os';

import { asAgentError, codedError, errorCode, failWith } from './coded_error.ts';
import * as codingExec from './coding_exec.ts';
import * as codingWorkspace from './coding_workspace.ts';
import * as codingLoop from './coding_loop.ts';
import * as evidence from './evidence.ts';
import * as patchMerge from './patch_merge.ts';
import * as verification from './verification.ts';
import { billableCodingUsage, codingCancelled, codingFailure } from './coding_runtime.ts';
import { submitChecks } from './submit_checks.ts';
import { codingCall } from './agents/model_usage.ts';
import type * as ipc from '../shared/ipc_types.ts';
import type { CodingEventPage, CodingRun } from '../shared/coding_types.ts';
import type { AppContext } from './app_context.ts';
import type { CodingRuntime } from './coding_runtime.ts';

type ActiveRound = {
  run: ipc.CodingRun;
  controller: AbortController;
  events: ipc.CodingEvent[];
  workspace: codingWorkspace.PreparedCodingWorkspace;
};

const MAX_CODING_EVENTS = 200;

// A new round may start once the previous one has finished or handed its
// patch over; ready (unapplied) and in-flight rounds block it.
const CODING_STARTABLE: ipc.CodingRunStatus[] = ['failed', 'cancelled', 'discarded', 'applied', 'submitted'];

// `startReview` hands a submitted package to QA.
export const createCodingService = (ctx: AppContext, runtime: CodingRuntime, { startReview }: { startReview: (id: string) => Promise<unknown> }) => {
  const { store, backgroundRuns, getPreferences, requireTask, requireRoot, record, recordCall } = ctx;

  const activeRounds = new Map<string, ActiveRound>();
  const eventHistory = new Map<string, ipc.CodingEvent[]>();
  ctx.onCancelAll(() => eventHistory.clear());

  const codingRunOf = (id: string) => {
    const task = requireTask(id);
    const run = store.get(id).codingRun ?? activeRounds.get(id)?.run;
    if (!run) throw codedError('No coding run exists', 'coding_not_running');
    return { task, run };
  };
  const workspaceOf = (id: string, run: CodingRun) => activeRounds.get(id)?.workspace ?? { runName: run.runName, directory: run.runName };
  const updateCoding = async (id: string, patch: Partial<CodingRun>) => {
    const state = await store.updateCodingRun(id, patch);
    const active = activeRounds.get(id);
    if (active?.run) active.run = state.codingRun as CodingRun;
    return state;
  };

  // How each file of `patch` would merge into the working tree now.
  const previewOf = (run: CodingRun, patch: string) => runtime.previewMerge(requireRoot(), run.baseline, codingWorkspace.filePatches(patch));

  // One coding round. The developer's round starts a chain at attempt 1;
  // automatic rounds continue it with feedback, from the current working tree.
  const startRound = async (
    id: string,
    { instruction, trigger, feedback }: { instruction: string; trigger: ipc.CodingTrigger; feedback: string | null },
  ): Promise<ipc.TaskView> => {
    const runtimeConfig = { ...getPreferences().agents['coding-agent'] };
    const timeoutMinutes = getPreferences().coding.timeoutMinutes;
    const task = requireTask(id);
    const state = store.get(id);
    if (state.status !== 'in_progress') failWith('Coding Agent can only run on an in-progress package', 'invalid_state');
    // A practice package is the developer's exercise; release it to hand it over.
    if (state.mode === 'practice') failWith('This package is being practised; Coding Agent stays out', 'practice_mode');
    if (activeRounds.has(id) || backgroundRuns.has('coding-checks', id)) failWith('A Coding Agent run is already active', 'coding_running');
    const previous = state.codingRun;
    if (previous && !CODING_STARTABLE.includes(previous.status)) failWith('This package already has a Coding Agent result', 'coding_result_exists');
    const root = requireRoot();
    // The developer's own edits and earlier applied rounds are part of the start.
    const baseline = await runtime.snapshot(root, ctx.requireBaseline(id), task.fileScope);
    const chained = trigger !== 'human' && previous;
    const runId = codingExec.codingRunId();
    const sandbox = await runtime.startSandbox();
    const initial: CodingRun = {
      id: runId,
      packageId: id,
      runName: runtime.runNameFor(sandbox, runId),
      baseline,
      status: 'preparing',
      user: sandbox ? os.userInfo().username : codingExec.CODING_USER,
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
    await store.setCodingRun(id, initial);
    record({ kind: 'coding_run', packageId: id, title: task.title, status: 'started', costUsd: null });
    const controller = backgroundRuns.start({ kind: 'coding', key: id, busy: 'coding', agent: () => 'coding-agent', label: ctx.packageLabel(id) });
    const active: ActiveRound = {
      run: initial,
      controller,
      events: [],
      workspace: { runName: initial.runName, directory: initial.runName },
    };
    activeRounds.set(id, active);
    eventHistory.set(id, []);
    const timeoutPatch = async (error: unknown, prepared: codingWorkspace.PreparedCodingWorkspace | null, cancelled: boolean) => {
      if (cancelled || !prepared || errorCode(error) !== 'coding_timeout') return undefined;
      return runtime.readPatch(prepared.runName, task.fileScope, { sandbox, cli: runtimeConfig.cli }).catch((failure) => void console.error(failure));
    };
    const settled = (async () => {
      let prepared: codingWorkspace.PreparedCodingWorkspace | null = null;
      try {
        prepared = await runtime.prepare(root, baseline, { runName: initial.runName, signal: controller.signal, sandbox, cli: runtimeConfig.cli });
        if (controller.signal.aborted) throw Object.assign(new Error('Coding run was cancelled'), { code: 'coding_aborted' });
        active.workspace = prepared;
        await updateCoding(id, { status: 'running' });
        const result = await runtime.run({
          runName: prepared.runName,
          config: runtimeConfig,
          prompt: runtime.codingPrompt(task, instruction, feedback),
          timeoutMs: timeoutMinutes * 60 * 1000,
          signal: controller.signal,
          sandbox,
          onEvent: (event) => {
            active.events.push(event);
            if (active.events.length > MAX_CODING_EVENTS) active.events = active.events.slice(-MAX_CODING_EVENTS);
          },
        });
        active.events = result.events.map((event, sequence) => ({ ...event, sequence })).slice(-MAX_CODING_EVENTS);
        eventHistory.set(id, [...active.events]);
        await updateCoding(id, { status: 'checking', output: result.output, usage: result.usage, sessionId: result.sessionId });
        const preview = await runtime.readPatch(prepared.runName, task.fileScope, { signal: controller.signal, sandbox, cli: runtimeConfig.cli });
        await updateCoding(id, {
          status: 'ready',
          finishedAt: new Date().toISOString(),
          files: preview.files,
          blocked: preview.blocked,
          patchDigest: preview.digest,
        });
        record({ kind: 'coding_run', packageId: id, title: task.title, status: 'finished', costUsd: result.usage.costUsd });
        recordCall('coding-agent', codingCall(runtimeConfig.cli, runtimeConfig.model, result.usage), { kind: 'package', id });
      } catch (error) {
        const cancelled = codingCancelled(error, controller.signal);
        // A failed, timed-out or cancelled round can still have been billed.
        const spent = billableCodingUsage(error);
        if (spent) {
          recordCall('coding-agent', codingCall(runtimeConfig.cli, runtimeConfig.model, spent), { kind: 'package', id });
          await updateCoding(id, { usage: spent }).catch((failure) => console.error(failure));
        }
        // A timed-out round keeps what it wrote so far for the developer to
        // review; it is never applied automatically.
        const partial = await timeoutPatch(error, prepared, cancelled);
        if (partial?.files.length) {
          await updateCoding(id, {
            status: 'ready',
            finishedAt: new Date().toISOString(),
            error: codingFailure(error),
            halt: 'timed_out',
            files: partial.files,
            blocked: partial.blocked,
            patchDigest: partial.digest,
          }).catch((failure) => console.error(failure));
          record({ kind: 'coding_run', packageId: id, title: task.title, status: 'failed', costUsd: spent?.costUsd ?? null });
          return;
        }
        await updateCoding(id, {
          status: cancelled ? 'cancelled' : 'failed',
          finishedAt: new Date().toISOString(),
          error: codingFailure(error),
        }).catch(() => {});
        record({ kind: 'coding_run', packageId: id, title: task.title, status: cancelled ? 'cancelled' : 'failed', costUsd: spent?.costUsd ?? null });
      } finally {
        eventHistory.set(id, [...active.events]);
        const current = store.get(id).codingRun;
        if (prepared && current && current.status !== 'ready' && current.status !== 'applied') await runtime.cleanRun(prepared.runName).catch(() => {});
        activeRounds.delete(id);
        backgroundRuns.finish('coding', id, controller);
      }
      // Automatic rounds go on by themselves; the developer's round waits for
      // a per-file review.
      const settledRun = store.get(id).codingRun;
      if (trigger !== 'human' && settledRun?.status === 'ready' && !settledRun.halt) continueLoop(id, () => autoApplyRound(id));
    })();
    backgroundRuns.track(settled);
    return ctx.viewOf(task, store.get(id));
  };

  // An automatic round's patch: applied whole unless it touches a high-risk
  // path, which stops the loop for the developer.
  const autoApplyRound = async (id: string) => {
    const { task, run } = codingRunOf(id);
    const preview = await runtime.readRunPatch(run.runName, task.fileScope);
    const decision = codingLoop.autoApply(preview);
    if (decision.highRisk) return void (await updateCoding(id, { halt: 'high_risk' }));
    if (!decision.files.length) {
      await runtime.cleanRun(run.runName).catch((error) => console.error(error));
      return void (await updateCoding(id, { status: 'discarded', halt: 'no_changes' }));
    }
    // The developer edited the same lines meanwhile: never overwrite, ask.
    const merge = await previewOf(run, preview.patch);
    if (merge.some((file) => file.state === 'conflict')) return void (await updateCoding(id, { halt: 'conflict' }));
    await applyRound(id, preview, decision.files, false, {});
    await verifyApplied(id);
  };

  // Applies the chosen files of a ready patch to the working tree.
  const applyRound = async (
    id: string,
    preview: ipc.CodingPatchPreview,
    files: string[],
    allowHighRisk: boolean,
    resolutions: Partial<Record<string, ipc.CodingResolution>>,
  ): Promise<ipc.CodingApplyResult> => {
    const { task, run } = codingRunOf(id);
    const selected = codingWorkspace.parsePatchPreview(codingWorkspace.selectPatch(preview.patch, files), task.fileScope);
    const blocked = allowHighRisk ? selected.blocked.filter((entry) => entry.reason !== 'high-risk project control or test path') : selected.blocked;
    await updateCoding(id, { status: 'applying', error: null });
    try {
      const applied = await runtime.applyPatch(requireRoot(), selected.patch, selected.digest, blocked, { baseline: run.baseline, resolutions });
      await updateCoding(id, {
        status: applied.markers.length ? 'applied' : 'verifying',
        halt: applied.markers.length ? 'markers' : null,
        finishedAt: new Date().toISOString(),
        files: selected.files,
        blocked: preview.blocked,
        patchDigest: selected.digest,
      });
      await runtime.cleanRun(run.runName).catch((error) => console.error(error));
      return { files: applied.written, markers: applied.markers, kept: applied.kept };
    } catch (error) {
      await updateCoding(id, { status: 'ready', error: codingFailure(error) });
      throw error;
    }
  };

  // Runs the submit checks on the applied patch with the developer's
  // permissions. A clean run hands the package to QA; a blocking failure
  // starts the next round while attempts remain.
  const verifyApplied = async (id: string) => {
    // Submit checks running on an applied patch, per package.
    const controller = backgroundRuns.start({ kind: 'coding-checks', key: id, busy: 'coding', label: ctx.packageLabel(id) });
    const config = ctx.getConfig();
    const baselines = store.get(id).baselineChecks?.checks ?? {};
    const failures: Parameters<typeof codingLoop.checksFeedback>[0] = [];
    const runs: ipc.CodingRun['checks'] = {};
    try {
      const { path: envPath } = await ctx.commandPath();
      for (const check of submitChecks(config)) {
        if (controller.signal.aborted) break;
        let outcome: Parameters<typeof evidence.evaluate>[1];
        try {
          const run = await verification.runCheck(config, check.kind, { signal: controller.signal, envPath });
          // runCheck() echoes the kind it ran, which is a CheckKind here.
          runs[check.kind] = { ...run, kind: check.kind };
          outcome = run;
        } catch (error) {
          outcome = { error: { code: errorCode(error) ?? 'not_run', message: error instanceof Error ? error.message : String(error) } };
        }
        const item = evidence.evaluate(check, outcome, evidence.usableBaseline(baselines[check.kind], check.line));
        if (item.status === 'fail' && check.blocking) failures.push({ evidence: item, run: runs[check.kind] ?? null });
      }
    } finally {
      backgroundRuns.finish('coding-checks', id, controller);
    }
    if (controller.signal.aborted) return void (await updateCoding(id, { status: 'applied', checks: runs, halt: 'stopped' }));
    const run = (await updateCoding(id, { checks: runs })).codingRun as CodingRun;
    if (failures.length) {
      if (!codingLoop.canRetry(run)) return void (await updateCoding(id, { status: 'applied', halt: 'attempts_exhausted' }));
      await updateCoding(id, { status: 'applied' });
      await startRound(id, { instruction: run.instruction, trigger: 'checks_failed', feedback: codingLoop.checksFeedback(failures) });
      return;
    }
    await updateCoding(id, { status: 'submitted' });
    const before = store.get(id).status;
    const entry = await store.transition(id, 'coding_submitted', 'coding-agent');
    ctx.recordTransition(id, before, entry, 'coding_submitted', 'coding-agent');
    await startReview(id).catch(async (error) => {
      console.error(error);
      await store.failReview(id, asAgentError(error)).catch((failure) => console.error(failure));
    });
  };

  // Runs one automatic step of the loop in the background. A failure stops
  // the loop with the error on the run, never silently.
  const continueLoop = (id: string, step: () => Promise<void>) =>
    backgroundRuns.track(
      step().catch(async (error) => {
        console.error(error);
        if (store.get(id).codingRun) await updateCoding(id, { halt: 'stopped', error: codingFailure(error) }).catch((failure) => console.error(failure));
      }),
    );

  // After QA sends a Coding Agent submission back, the next round takes its
  // issues while attempts remain. Runs in the background.
  const continueAfterReview = (id: string) =>
    continueLoop(id, async () => {
      const state = store.get(id);
      const run = state.codingRun;
      if (state.status !== 'in_progress' || run?.status !== 'submitted' || state.review?.status !== 'rejected') return;
      if (!codingLoop.canRetry(run)) return void (await updateCoding(id, { halt: 'attempts_exhausted' }));
      const { reasons = [], report = null, checks = [] } = state.review;
      const feedback = codingLoop.reviewFeedback({ reasons, report: report as ipc.QaReport | null, checks });
      await startRound(id, { instruction: run.instruction, trigger: 'qa_rejected', feedback });
    });

  // The developer's round.
  const start = (id: string, instruction: string) => startRound(id, { instruction, trigger: 'human', feedback: null });

  // A page of the round's events after sequence `after`.
  const events = (id: string, after: number): CodingEventPage => {
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
      await updateCoding(id, { status: 'discarded', finishedAt: new Date().toISOString(), halt: run.trigger === 'human' ? null : 'stopped' });
      return true;
    }
    active.controller.abort();
    if (active.run.trigger !== 'human') await updateCoding(id, { halt: 'stopped' }).catch((error) => console.error(error));
    return true;
  };

  // The packages with a round or its checks in flight. Read from memory.
  const activeRuns = (): ipc.CodingActiveRun[] =>
    [...new Set([...backgroundRuns.keys('coding'), ...backgroundRuns.keys('coding-checks')])].map((packageId) => ({
      packageId,
      title: ctx.catalog.getTask(packageId)?.title ?? packageId,
    }));

  // The patch of a ready or applied round; a ready one with how it merges now.
  const patch = async (id: string): Promise<ipc.CodingPatchPreview> => {
    const { task, run } = codingRunOf(id);
    if (!['ready', 'applied'].includes(run.status)) failWith('Coding patch is not ready', 'coding_not_ready');
    const preview = await runtime.readRunPatch(workspaceOf(id, run).runName, task.fileScope);
    await updateCoding(id, { files: preview.files, blocked: preview.blocked, patchDigest: preview.digest });
    if (run.status !== 'ready') return preview;
    const merge = await previewOf(run, preview.patch);
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
    }: { digest: string; allowHighRisk: boolean; files: string[]; resolutions: Partial<Record<string, ipc.CodingResolution>> },
  ): Promise<ipc.CodingApplyResult> => {
    const { task, run } = codingRunOf(id);
    if (run.status !== 'ready') failWith('Coding patch is not ready to apply', 'coding_not_ready');
    const preview = await runtime.readRunPatch(workspaceOf(id, run).runName, task.fileScope);
    // The digest covers the patch and how it merges now: an edit to a
    // patched file since the developer looked sends them back to look again.
    const merge = await previewOf(run, preview.patch);
    if (patchMerge.mergeDigest(preview.patch, merge) !== digest) failWith('Patch or working tree changed since preview', 'coding_digest_mismatch');
    const selected = new Set(files);
    const unresolved = merge.find((file) => file.state === 'conflict' && selected.has(file.path) && !resolutions[file.path]);
    if (unresolved) failWith(`Choose how to resolve ${unresolved.path}`, 'merge_unresolved', 'resolutions');
    // The round's "finished" was recorded when it produced the patch.
    const applied = await applyRound(id, preview, files, allowHighRisk, resolutions);
    activeRounds.delete(id);
    // Conflict markers left in a file hold the checks until they are cleared.
    if (!applied.markers.length) continueLoop(id, () => verifyApplied(id));
    return applied;
  };

  // After the developer cleared the conflict markers an apply left, the
  // automatic flow goes on: checks, then QA. Refused while a marker remains.
  const resume = async (id: string): Promise<ipc.TaskView> => {
    const { task, run } = codingRunOf(id);
    if (run.status !== 'applied' || run.halt !== 'markers') failWith('Nothing is waiting on conflict markers', 'coding_not_ready');
    const left = await patchMerge.filesWithMarkers(
      requireRoot(),
      run.files.map((file) => file.path),
    );
    if (left.length) failWith(`Conflict markers remain in ${left.join(', ')}`, 'merge_markers_left');
    await updateCoding(id, { status: 'verifying', halt: null });
    continueLoop(id, () => verifyApplied(id));
    return ctx.viewOf(task, store.get(id));
  };

  return { codingRunOf, start, continueAfterReview, events, cancel, activeRuns, patch, apply, resume };
};

export type CodingService = ReturnType<typeof createCodingService>;
