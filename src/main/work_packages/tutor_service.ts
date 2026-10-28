// Tutor's hint ladder for one step of a work package (../shared/hint_ladder.ts):
// which level may be opened, how one is written and filtered, and what is
// recorded. ./ipc/tutor.ts only routes to it.
//
// Levels open one at a time: the next ask may be one above the highest
// opened at the step, never further. Each opened level is recorded in the
// package's state (WorkPackageState.hints) the first time this claim shows
// it, a saved answer included, so reopening help from an earlier claim
// still counts.
//
// The output filter does not rely on the prompt: ./agents/tutor.ts's
// validateAnswer drops code a level may not carry, then ./hint_leak.ts
// compares what is left with the reference solution when there is one. A
// leak is asked again once; a second leak keeps only the text. A course lab
// falls back on its pre-written hints.json when Tutor fails.
//
// Hidden tests never reach Tutor: the prompt is built from the package, its
// committed scope files and the public checks' failures only.
//
// [人工决策-2026-10-27 00:51:12] 提示梯度课程 lab 和项目 practice 包同一套：逐级解锁，记录到工作包状态，用到 L5 后参考答案解锁。
// [人工决策-2026-10-27 00:36:21] 提示梯度（hints.json）、参考解、隐藏测试是私有产物，只在主进程里读，不经 IPC 下发。
import fs from 'node:fs/promises';
import path from 'node:path';

import { logger } from '../infrastructure/logger.ts';
import { asAgentError, failWith } from '../infrastructure/coded_error.ts';
import * as tutorAgent from '../agents/tutor.ts';
import * as hintLeak from './hint_leak.ts';
import * as labs from '../courses/labs.ts';
import * as practice from './practice.ts';
import { HIDDEN_CHECK_KIND } from '../courses/lab_hidden.ts';
import { readTracked } from '../repository/repo_reader.ts';
import { throwIfCancelled } from '../agents/pipeline.ts';
import { HINT_CODE_LINES, MAX_HINT_LEVEL, isHintLevel, openedLevel } from '../../shared/hint_ladder.ts';
import type * as envelopeTypes from '../../shared/ipc/envelope.ts';
import type * as tutorTypes from '../../shared/ipc/tutor.ts';
import type { AppContext } from '../app/app_context.ts';
import type { TaskDefinition } from './tasks.ts';
import type { Review } from './work_package_state.ts';
import type { TutorRecord, TutorStore } from './tutor_store.ts';

type TutorServiceContext = Pick<
  AppContext,
  | 'backgroundRuns'
  | 'commandPath'
  | 'course'
  | 'getConfig'
  | 'onCancelAll'
  | 'packageLabel'
  | 'profile'
  | 'repositories'
  | 'requireTask'
  | 'runnerFor'
  | 'store'
  | 'tutor'
>;

// Failing public tests Tutor is shown at L4.
const MAX_FAILING_TESTS = 10;

type Step = { task: TaskDefinition; stepIndex: number; step: string };
type Written = { answer: tutorAgent.TutorAnswer; filtered: boolean; source: 'tutor' | 'lab'; costUsd: number };

const RETRY_AFTER_LEAK =
  'Your previous answer at this level repeated the reference solution. Explain in your own words and write different code: other structure, other names, only what this level needs.';

const tutorKey = (id: string, stepIndex: number) => `${id}#${stepIndex}`;

// The public tests failing in the package's latest review, never the hidden ones.
const failingPublicTests = (review: Review | null): string[] =>
  (review?.checks ?? [])
    .filter((check) => check.kind !== HIDDEN_CHECK_KIND)
    .flatMap((check) => check.newFailures)
    .slice(0, MAX_FAILING_TESTS);

// The lab's pre-written hint for `level`, filtered like Tutor's own.
const labHint = (hint: labs.LabHint, task: TaskDefinition, reference: hintLeak.LeakReference | null): Written => {
  let code = hint.code && tutorAgent.codeLines(hint.code) <= HINT_CODE_LINES[hint.level] ? hint.code : null;
  const leaked = Boolean(code && reference && hintLeak.checkLeak([code], reference).leaked);
  if (leaked) code = null;
  const language = path.extname(task.fileScope[0] ?? '').slice(1) || 'text';
  return {
    answer: { explanation: hint.text, hints: [], snippet: code ? { language, code } : null, terms: [] },
    filtered: hint.code !== code,
    source: 'lab',
    costUsd: 0,
  };
};

export const createTutorService = (ctx: TutorServiceContext) => {
  const { backgroundRuns, store } = ctx;

  // The latest failed ask per step, kept until the next ask.
  const failures = new Map<string, { level: number; error: envelopeTypes.ErrorInfo }>();
  // The level each running ask is writing.
  const pendingLevels = new Map<string, number>();
  ctx.onCancelAll(() => failures.clear());

  const requireTutor = (): TutorStore => {
    if (!ctx.tutor) return failWith('Tutor is unavailable', 'unsupported');
    return ctx.tutor;
  };

  const requireStep = (id: string, rawIndex: unknown): Step => {
    const task = ctx.requireTask(id);
    if (!Number.isInteger(rawIndex) || (rawIndex as number) < 0 || (rawIndex as number) >= task.steps.length) {
      failWith('stepIndex is not a step of this package', 'invalid_step');
    }
    return { task, stepIndex: rawIndex as number, step: task.steps[rawIndex as number] };
  };

  const openedAt = ({ task, stepIndex }: Step) => openedLevel(store.get(task.id).hints ?? [], stepIndex);

  const state = (target: Step): tutorTypes.TutorState => {
    const { task, stepIndex, step } = target;
    const key = tutorKey(task.id, stepIndex);
    const opened = openedAt(target);
    const levels: tutorTypes.TutorLevel[] = [];
    for (let level = 1; level <= opened; level += 1) {
      const saved = requireTutor().get(task.id, stepIndex, step, level);
      if (saved) levels.push({ level, answer: saved.answer, filtered: saved.filtered, source: saved.source, costUsd: saved.costUsd });
    }
    const base = { levels, opened, maxLevel: MAX_HINT_LEVEL };
    if (backgroundRuns.has('tutor', key)) return { ...base, status: 'running', pending: pendingLevels.get(key) ?? null, error: null };
    const failure = failures.get(key);
    if (failure) return { ...base, status: 'failed', pending: failure.level, error: failure.error };
    return { ...base, status: opened ? 'done' : 'idle', pending: null, error: null };
  };

  const record = (target: Step, saved: Pick<TutorRecord, 'level' | 'filtered'>) =>
    store.recordHint(target.task.id, { stepIndex: target.stepIndex, level: saved.level, at: new Date().toISOString(), filtered: saved.filtered });

  // The reference solution, prepared for the leak check; null without one.
  const referenceFor = async (task: TaskDefinition): Promise<hintLeak.LeakReference | null> => {
    if (store.get(task.id).referenceRun?.status !== 'ready') return null;
    const patch = await fs.readFile(practice.referenceFileOf(ctx.repositories.dataDir(), task), 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') logger.error('[tutor] reference unreadable', error);
      return null;
    });
    return patch === null ? null : hintLeak.prepareReference(patch);
  };

  // Tutor writes `level`; an answer that leaks is asked for again once,
  // then kept as text only.
  const write = async (target: Step, level: number, reference: hintLeak.LeakReference | null, signal: AbortSignal): Promise<Written> => {
    const { task, stepIndex, step } = target;
    const config = ctx.getConfig();
    const read = config.root ? await readTracked(config.root, task.fileScope.slice(0, tutorAgent.MAX_TUTOR_FILES)) : { files: [], skipped: [] };
    const missing = read.skipped.filter((item) => item.reason === 'not_tracked').map((item) => item.path);
    const earlier: { level: number; answer: tutorAgent.TutorAnswer }[] = [];
    for (let lower = 1; lower < level; lower += 1) {
      const saved = requireTutor().get(task.id, stepIndex, step, lower);
      if (saved) earlier.push({ level: lower, answer: saved.answer });
    }
    const failingTests = level === 4 ? failingPublicTests(store.get(task.id).review) : [];
    const [profile, course, { path: envPath }] = await Promise.all([ctx.profile(config), ctx.course(config), ctx.commandPath()]);
    const runner = ctx.runnerFor('tutor', { kind: 'package', id: task.id });
    let costUsd = 0;
    let leaked: tutorAgent.TutorAnswer | null = null;
    for (const retryReason of [null, RETRY_AFTER_LEAK]) {
      throwIfCancelled(signal);
      const { output, costUsd: spent } = await runner({
        prompt: tutorAgent.tutorPrompt({ task, stepIndex, level, earlier, failingTests, retryReason, sources: read.files, missing, profile }),
        systemPrompt: tutorAgent.systemPrompt(course.pack),
        schema: tutorAgent.tutorSchema(level),
        envPath,
        signal,
      });
      throwIfCancelled(signal);
      costUsd += spent ?? 0;
      const { answer, filtered } = tutorAgent.validateAnswer(output, level);
      const verdict = reference ? hintLeak.checkLeak(hintLeak.codeOf(answer), reference) : null;
      logger.debug(`[tutor] answer package=${task.id} step=${stepIndex} level=${level} leaked=${verdict?.leaked ?? 'unchecked'} run=${verdict?.run ?? 0}`);
      if (!verdict?.leaked) return { answer, filtered, source: 'tutor', costUsd };
      leaked = answer;
    }
    // Both attempts gave the reference away: only the text is kept.
    return { answer: tutorAgent.textOnly(leaked as tutorAgent.TutorAnswer), filtered: true, source: 'tutor', costUsd };
  };

  const run = async (target: Step, level: number, controller: AbortController) => {
    const { task, stepIndex, step } = target;
    const key = tutorKey(task.id, stepIndex);
    const reference = await referenceFor(task);
    let written: Written | null = null;
    try {
      written = await write(target, level, reference, controller.signal);
    } catch (error) {
      const cancelled = controller.signal.aborted;
      if (cancelled) return void failures.set(key, { level, error: { code: 'agent_cancelled', message: 'Tutor was cancelled' } });
      logger.error('[tutor] run failed', error);
      // A lab has its own ladder to fall back on.
      const fallback = task.lab ? (await labs.readHints(ctx.repositories.dataDir(), task.lab.id)).find((hint) => hint.level === level) : undefined;
      if (fallback) written = labHint(fallback, task, reference);
      else {
        const info = asAgentError(error);
        failures.set(key, { level, error: { code: info.code ?? 'agent_failed', message: info.message } });
      }
    }
    if (!written) return;
    const saved = await requireTutor().put({ packageId: task.id, stepIndex, step, level, ...written, createdAt: new Date().toISOString() });
    await record(target, saved);
    logger.debug(`[tutor] opened package=${task.id} step=${stepIndex} level=${level} source=${saved.source} filtered=${saved.filtered}`);
  };

  const ask = async (target: Step, rawLevel: unknown): Promise<tutorTypes.TutorState> => {
    const { task, stepIndex, step } = target;
    const key = tutorKey(task.id, stepIndex);
    if (!isHintLevel(rawLevel)) failWith(`level must be 1 to ${MAX_HINT_LEVEL}`, 'invalid_level');
    const level = rawLevel as number;
    const opened = openedAt(target);
    if (level > opened + 1) failWith(`Open level ${opened + 1} first`, 'level_locked');
    if (backgroundRuns.has('tutor', key)) return state(target);
    // A level written before (this claim or an earlier one) is shown again for free.
    const saved = requireTutor().get(task.id, stepIndex, step, level);
    if (saved) {
      if (level > opened) await record(target, saved);
      return state(target);
    }
    const controller = backgroundRuns.start({ kind: 'tutor', key, busy: 'tutor', agent: () => 'tutor', label: ctx.packageLabel(task.id) });
    failures.delete(key);
    pendingLevels.set(key, level);
    logger.debug(`[tutor] ask package=${task.id} step=${stepIndex} level=${level}`);
    backgroundRuns.track(
      run(target, level, controller)
        .catch((error) => logger.error('[tutor] could not save the answer', error))
        .finally(() => {
          pendingLevels.delete(key);
          backgroundRuns.finish('tutor', key, controller);
        }),
    );
    return state(target);
  };

  const cancel = ({ task, stepIndex }: Step): boolean => {
    const controller = backgroundRuns.get('tutor', tutorKey(task.id, stepIndex));
    controller?.abort();
    return Boolean(controller);
  };

  const countCopy = async (id: string): Promise<number> => {
    ctx.requireTask(id);
    return (await store.countSnippetCopy(id)).snippetCopies;
  };

  return { requireStep, state, ask, cancel, countCopy };
};
