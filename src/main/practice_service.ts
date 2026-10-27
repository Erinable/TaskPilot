// Practice: a reference solution and Tutor's grade. See ./practice.ts for the
// rules. Both runs belong to one claim: release, replan and a repository
// switch abort them, and a late write from a replaced run is dropped by the
// store (setReferenceRun/setGrade `expect`). A course lab brings its own
// reference (./labs.ts), so claiming one starts no run.
import fs from 'node:fs/promises';
import path from 'node:path';

import { asAgentError, failWith } from './coded_error.ts';
import * as codingExec from './coding_exec.ts';
import * as practice from './practice.ts';
import * as courses from './courses.ts';
import * as tutorAgent from './agents/tutor.ts';
import { billableCodingUsage, codingCancelled, codingFailure } from './coding_runtime.ts';
import { reportIgnore } from './submit_checks.ts';
import { collectChanges } from './review_diff.ts';
import { codingCall } from './agents/model_usage.ts';
import { throwIfCancelled } from './agents/pipeline.ts';
import { toWireState } from './app_context.ts';
import { parsePatchPreview } from './coding_workspace.ts';
import type * as codingWorkspace from './coding_workspace.ts';
import type * as packageTypes from '../shared/ipc/packages.ts';
import type { AppContext } from './app_context.ts';
import type { CodingRuntime } from './coding_runtime.ts';

export const createPracticeService = (ctx: AppContext, runtime: CodingRuntime) => {
  const { store, backgroundRuns, getPreferences, requireTask, requireRoot, requireBaseline, recordCall } = ctx;

  const referenceFile = (id: string) => practice.referenceFileOf(ctx.repositories.dataDir(), requireTask(id));

  // A lab's reference passed its self-check when the lab was written: it is
  // ready at the claim, and only its file list leaves the main process.
  const readyLabReference = async (id: string) => {
    const task = requireTask(id);
    const at = new Date().toISOString();
    const patch = await fs.readFile(referenceFile(id), 'utf8').catch((error) => {
      console.error('[reference] lab reference unreadable', error);
      return null;
    });
    const files =
      patch === null ? [] : parsePatchPreview(patch, task.fileScope).files.map((file) => ({ path: file.path, added: file.added, removed: file.removed }));
    await store.setReferenceRun(id, {
      id: codingExec.codingRunId(),
      status: patch === null ? 'failed' : 'ready',
      startedAt: at,
      finishedAt: at,
      error: patch === null ? { code: 'no_reference', message: 'The lab has no reference solution' } : null,
      files,
      costUsd: 0,
      revealedAt: null,
      source: 'lab',
    });
    console.debug(`[reference] lab package=${id} files=${files.length}`);
  };

  // Coding Agent writes the reference in its own run directory, from the
  // claimed commit, in the background. Never applied; never auto-retried.
  const startReference = (id: string) => {
    const task = requireTask(id);
    if (task.lab) {
      backgroundRuns.track(readyLabReference(id).catch((error) => console.error('[reference] lab reference failed', error)));
      return;
    }
    const root = requireRoot();
    const config = ctx.getConfig();
    const baseline = requireBaseline(id);
    const runtimeConfig = { ...getPreferences().agents['coding-agent'] };
    const timeoutMinutes = getPreferences().coding.timeoutMinutes;
    const controller = backgroundRuns.start({ kind: 'reference', key: id, busy: 'reference', agent: () => 'coding-agent', label: ctx.packageLabel(id) });
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
      source: 'run',
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
        const profile = await ctx.profile(config);
        // [人工决策-2026-10-26 15:38:21] 参考答案的指令来自当前生效课程包的 referenceGuide。
        const course = await ctx.course(config);
        const result = await runtime.run({
          runName: prepared.runName,
          config: runtimeConfig,
          prompt: runtime.codingPrompt(task, course.pack.referenceGuide, null, profile),
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
    const config = ctx.getConfig();
    const collected = await collectChanges(root, requireBaseline(id), { ignore: reportIgnore(await ctx.runnableSteps().catch(() => [])) });
    const submission = collected.files.map((file) => ({ path: file.path, patch: file.patch }));
    const diffDigest = practice.submissionDigest(submission);
    if (!force && practice.alreadyGraded(state.grade, diffDigest)) return ctx.viewOf(task, state);
    const reference = state.referenceRun;
    const wireReview = toWireState(state).review;
    const repoId = ctx.repositories.current?.id ?? null;
    const gradeId = codingExec.codingRunId();
    // The pack in use now; a repository pack not yet confirmed is never it (./courses.ts).
    const { pack: course, ref: courseRef } = await ctx.course(config);
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
      course: { id: courseRef.id, version: courseRef.version, contentHash: courseRef.contentHash, rubric: structuredClone(course.rubric) },
    };
    if (reference?.status === 'running' && !skipReference) {
      await store.setGrade(id, { ...base, status: 'waiting' });
      console.debug(`[grade] waiting package=${id} for the reference`);
      return ctx.viewOf(task, store.get(id));
    }
    const referencePatch = reference?.status === 'ready' ? await fs.readFile(referenceFile(id), 'utf8').catch(() => null) : null;
    const controller = backgroundRuns.start({ kind: 'grade', key: id, busy: 'grade', agent: () => 'tutor', label: ctx.packageLabel(id) });
    await store.setGrade(id, { ...base, withReference: referencePatch !== null });
    const tutorRunner = ctx.runnerFor('tutor', { kind: 'package', id });
    const { path: envPath } = await ctx.commandPath();
    const profile = await ctx.profile(config);
    const history = ctx.notes
      ? practice.notesForGrade(
          ctx.notes.list().notes,
          submission.map((file) => file.path),
          course,
          courses.knownPacks(ctx.builtinCourses, course),
        )
      : [];
    console.debug(`[grade] start package=${id} course=${courseRef.id} files=${submission.length} reference=${referencePatch !== null} notes=${history.length}`);
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
            profile,
          }),
          systemPrompt: tutorAgent.gradeSystemPrompt(course),
          schema: tutorAgent.gradeSchema(course),
          envPath,
          signal: controller.signal,
        });
        throwIfCancelled(controller.signal);
        finished = {
          status: 'done',
          report: tutorAgent.validateGrade(output, { changedPaths: submission.map((file) => file.path), hasNotes: history.length > 0, course }),
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
      const finishedAt = new Date().toISOString();
      const written = await store.setGrade(id, { ...base, withReference: referencePatch !== null, ...finished, finishedAt }, gradeId);
      console.debug(`[grade] done package=${id} status=${finished.status} kept=${Boolean(written)}`);
      // [人工决策-2026-10-27 00:36:21] 判卷 done 时按知识点写一次掌握度；同一包同一次提交（diffDigest）只写一次，ai 模式不写。
      // Mastery is a side record: a failed write is logged and the grade stands.
      if (written && finished.report && ctx.mastery && repoId) {
        await ctx.mastery
          .record({
            mode: state.mode,
            // The concepts are ids of the pack the package was planned with.
            course: task.course?.id ?? courseRef.id,
            concepts: task.concepts ?? [],
            packageId: id,
            repoId,
            diffDigest,
            review: wireReview,
            report: finished.report,
            at: finishedAt,
          })
          .catch((error) => console.error('[mastery] record failed', error));
      }
    })();
    backgroundRuns.track(settled);
    return ctx.viewOf(task, store.get(id));
  };

  // [人工决策-2026-10-27 00:51:12] 本包测试全部通过或提示梯度用到 L5 之后才返回参考补丁，课程 lab 和项目 practice 包同一规则（./practice.ts referenceLock）。
  const revealReference = async (id: string): Promise<string> => {
    requireTask(id);
    const state = store.get(id);
    if (state.referenceRun?.status !== 'ready') failWith('There is no reference solution', 'no_reference');
    const lock = practice.referenceLock({ referenceRun: state.referenceRun, review: toWireState(state).review }, practice.usedHintLevel(state));
    if (!lock?.unlocked) failWith('Pass every test of this package first, or use the hints up to L5', 'reference_locked');
    if (!state.referenceRun.revealedAt) await store.setReferenceRun(id, { ...state.referenceRun, revealedAt: new Date().toISOString() }, state.referenceRun.id);
    return fs.readFile(referenceFile(id), 'utf8');
  };

  return { startReference, startGrade, revealReference };
};

export type PracticeService = ReturnType<typeof createPracticeService>;
