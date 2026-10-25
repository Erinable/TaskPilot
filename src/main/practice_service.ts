// Practice: a reference solution and Tutor's grade. See ./practice.ts for the
// rules. Both runs belong to one claim: release, replan and a repository
// switch abort them, and a late write from a replaced run is dropped by the
// store (setReferenceRun/setGrade `expect`).
import fs from 'node:fs/promises';
import path from 'node:path';

import { asAgentError, failWith } from './coded_error.ts';
import * as codingExec from './coding_exec.ts';
import * as practice from './practice.ts';
import * as tutorAgent from './agents/tutor.ts';
import { billableCodingUsage, codingCancelled, codingFailure } from './coding_runtime.ts';
import { reportIgnore } from './submit_checks.ts';
import { collectChanges } from './review_diff.ts';
import { codingCall } from './agents/model_usage.ts';
import { throwIfCancelled } from './agents/pipeline.ts';
import { toWireState } from './app_context.ts';
import type * as codingWorkspace from './coding_workspace.ts';
import type * as packageTypes from '../shared/ipc/packages.ts';
import type { AppContext } from './app_context.ts';
import type { CodingRuntime } from './coding_runtime.ts';

export const createPracticeService = (ctx: AppContext, runtime: CodingRuntime) => {
  const { store, backgroundRuns, getPreferences, requireTask, requireRoot, requireBaseline, recordCall } = ctx;

  const referenceFile = (id: string) => practice.referencePath(ctx.repositories.dataDir(), id);

  // Coding Agent writes the reference in its own run directory, from the
  // claimed commit, in the background. Never applied; never auto-retried.
  const startReference = (id: string) => {
    const task = requireTask(id);
    const root = requireRoot();
    const baseline = requireBaseline(id);
    const runtimeConfig = { ...getPreferences().agents['coding-agent'] };
    const timeoutMinutes = getPreferences().coding.timeoutMinutes;
    const controller = backgroundRuns.start({ kind: 'reference', key: id, busy: 'reference', label: ctx.packageLabel(id) });
    const runId = codingExec.codingRunId();
    const initial: packageTypes.ReferenceRun = {
      id: runId,
      status: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      error: null,
      files: [],
      costUsd: null,
      revealedAt: null,
    };
    console.debug(`[reference] start package=${id} run=${runId}`);
    const settled = (async () => {
      await store.setReferenceRun(id, initial);
      const sandbox = await runtime.startSandbox();
      const runName = runtime.runNameFor(sandbox, runId);
      let prepared: codingWorkspace.PreparedCodingWorkspace | null = null;
      let finished: Partial<packageTypes.ReferenceRun>;
      try {
        prepared = await runtime.prepare(root, baseline, { runName, signal: controller.signal, sandbox, cli: runtimeConfig.cli });
        if (controller.signal.aborted) throw Object.assign(new Error('Reference run was cancelled'), { code: 'coding_aborted' });
        const result = await runtime.run({
          runName: prepared.runName,
          config: runtimeConfig,
          prompt: runtime.codingPrompt(
            task,
            'Write the complete solution to this work package. It is a reference answer for a learner, so follow the repository conventions closely.',
            null,
          ),
          timeoutMs: timeoutMinutes * 60 * 1000,
          signal: controller.signal,
          sandbox,
        });
        recordCall('coding-agent', codingCall(runtimeConfig.cli, runtimeConfig.model, result.usage), { kind: 'package', id });
        const preview = await runtime.readPatch(prepared.runName, task.fileScope, { signal: controller.signal, sandbox, cli: runtimeConfig.cli });
        await fs.mkdir(path.dirname(referenceFile(id)), { recursive: true });
        await fs.writeFile(referenceFile(id), preview.patch);
        finished = {
          status: 'ready',
          files: preview.files.map((file) => ({ path: file.path, added: file.added, removed: file.removed })),
          costUsd: result.usage.costUsd,
        };
      } catch (error) {
        const cancelled = codingCancelled(error, controller.signal);
        if (!cancelled) console.error('[reference] run failed', error);
        const spent = billableCodingUsage(error);
        if (spent) recordCall('coding-agent', codingCall(runtimeConfig.cli, runtimeConfig.model, spent), { kind: 'package', id });
        finished = { status: cancelled ? 'cancelled' : 'failed', error: codingFailure(error), costUsd: spent?.costUsd ?? null };
      } finally {
        if (prepared) await runtime.cleanRun(prepared.runName).catch((error) => console.error('[reference] clean failed', error));
        backgroundRuns.finish('reference', id, controller);
      }
      const written = await store.setReferenceRun(id, { ...initial, ...finished, finishedAt: new Date().toISOString() }, runId);
      console.debug(`[reference] done package=${id} run=${runId} status=${finished.status} kept=${Boolean(written)}`);
      // QA may have finished first; its grade waits for the reference.
      if (written?.grade?.status === 'waiting') startGrade(id, { force: true }).catch((error) => console.error('[grade] could not start', error));
    })();
    backgroundRuns.track(settled);
  };

  // Tutor grades the current submission once QA has judged it. With the
  // reference still running the grade waits (status 'waiting') unless the
  // developer chose not to; `force` regrades a failed or waiting grade.
  const startGrade = async (id: string, { force = false, skipReference = false }: { force?: boolean; skipReference?: boolean } = {}) => {
    const task = requireTask(id);
    const state = store.get(id);
    if (state.mode !== 'practice') failWith('Only practised packages are graded', 'not_practice');
    const review = practice.reviewForGrade(toWireState(state).review);
    if (!review) failWith('QA has not judged this submission yet', 'review_not_finished');
    if (backgroundRuns.has('grade', id)) return ctx.viewOf(task, state);
    const root = requireRoot();
    const collected = await collectChanges(root, requireBaseline(id), { ignore: reportIgnore(ctx.getConfig()) });
    const submission = collected.files.map((file) => ({ path: file.path, patch: file.patch }));
    const diffDigest = practice.submissionDigest(submission);
    if (!force && practice.alreadyGraded(state.grade, diffDigest)) return ctx.viewOf(task, state);
    const reference = state.referenceRun;
    const gradeId = codingExec.codingRunId();
    const base: packageTypes.Grade = {
      id: gradeId,
      status: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      error: null,
      diffDigest,
      withReference: false,
      report: null,
      costUsd: 0,
    };
    if (reference?.status === 'running' && !skipReference) {
      await store.setGrade(id, { ...base, status: 'waiting' });
      console.debug(`[grade] waiting package=${id} for the reference`);
      return ctx.viewOf(task, store.get(id));
    }
    const referencePatch = reference?.status === 'ready' ? await fs.readFile(referenceFile(id), 'utf8').catch(() => null) : null;
    const controller = backgroundRuns.start({ kind: 'grade', key: id, busy: 'grade', label: ctx.packageLabel(id) });
    await store.setGrade(id, { ...base, withReference: referencePatch !== null });
    const tutorRunner = ctx.runnerFor('tutor', { kind: 'package', id });
    const { path: envPath } = await ctx.commandPath();
    const history = ctx.notes
      ? practice.notesForGrade(
          ctx.notes.list().notes,
          submission.map((file) => file.path),
        )
      : [];
    console.debug(`[grade] start package=${id} files=${submission.length} reference=${referencePatch !== null} notes=${history.length}`);
    const settled = (async () => {
      let finished: Partial<packageTypes.Grade>;
      try {
        const { output, costUsd } = await tutorRunner({
          prompt: tutorAgent.gradePrompt({
            task,
            submission,
            reference: referencePatch && practice.referenceForPrompt(referencePatch),
            review,
            notes: history,
          }),
          systemPrompt: tutorAgent.GRADE_SYSTEM_PROMPT,
          schema: tutorAgent.GRADE_SCHEMA,
          envPath,
          signal: controller.signal,
        });
        throwIfCancelled(controller.signal);
        finished = {
          status: 'done',
          report: tutorAgent.validateGrade(output, { changedPaths: submission.map((file) => file.path), hasNotes: history.length > 0 }),
          costUsd: costUsd ?? 0,
        };
      } catch (error) {
        const cancelled = controller.signal.aborted;
        if (!cancelled) console.error('[grade] run failed', error);
        const info = asAgentError(error);
        finished = {
          status: 'failed',
          error: cancelled ? { code: 'agent_cancelled', message: 'Grading was cancelled' } : { code: info.code ?? 'agent_failed', message: info.message },
        };
      } finally {
        backgroundRuns.finish('grade', id, controller);
      }
      await store.setGrade(id, { ...base, withReference: referencePatch !== null, ...finished, finishedAt: new Date().toISOString() }, gradeId);
      console.debug(`[grade] done package=${id} status=${finished.status}`);
    })();
    backgroundRuns.track(settled);
    return ctx.viewOf(task, store.get(id));
  };

  // [人工决策-2026-10-24 12:51:21] 先交卷再看：首次提交审查之前不返回参考补丁。
  const revealReference = async (id: string): Promise<string> => {
    requireTask(id);
    const state = store.get(id);
    if (state.referenceRun?.status !== 'ready') failWith('There is no reference solution', 'no_reference');
    if (!state.review) failWith('Submit your own solution first', 'reference_locked');
    if (!state.referenceRun.revealedAt) await store.setReferenceRun(id, { ...state.referenceRun, revealedAt: new Date().toISOString() }, state.referenceRun.id);
    return fs.readFile(referenceFile(id), 'utf8');
  };

  return { startReference, startGrade, revealReference };
};

export type PracticeService = ReturnType<typeof createPracticeService>;
