// Explaining the differences: after a grade made with the reference, Tutor
// picks up to three key differences (./agents/tutor.ts differencesPrompt),
// the developer explains each or skips it, Tutor replies once to the
// answers, and the whole can be saved as one note with the package's
// concepts, course and category. The state lives on the grade
// (Grade.explanation) and counts towards neither score; only whether it was
// completed is kept.
//
// Tutor reads the reference here, so it starts only once the reference may
// be read (practice.referenceLock); the reference itself never leaves the
// main process through these channels, only Tutor's words about it.
//
// [人工决策-2026-10-27 00:36:21] 判卷后让学生解释和参考实现的关键差异：最多 3 处，可跳过，Tutor 只回一轮，一键存成带 concepts/course/category 的笔记；不计入分数。
import fs from 'node:fs/promises';
import path from 'node:path';

import { asAgentError, failWith } from './coded_error.ts';
import * as practice from './practice.ts';
import * as tutorAgent from './agents/tutor.ts';
import { collectChanges } from './review_diff.ts';
import { reportIgnore } from './submit_checks.ts';
import { throwIfCancelled } from './agents/pipeline.ts';
import { toWireState } from './app_context.ts';
import { toTitle } from '../shared/note_markdown.ts';
import { DEFAULT_COURSE_ID } from '../shared/course_pack.ts';
import type * as packageTypes from '../shared/ipc/packages.ts';
import type { AppContext } from './app_context.ts';
import type { TaskDefinition } from './tasks.ts';

export const MAX_ANSWER = 1000;

type Explanation = packageTypes.GradeExplanation;

// The grade an explanation belongs to: done, with a report and the reference.
const requireGrade = (state: { grade: packageTypes.Grade | null }): packageTypes.Grade & { report: packageTypes.GradeReport } => {
  const grade = state.grade;
  if (grade?.status !== 'done' || !grade.report) return failWith('The submission has not been graded yet', 'grade_not_done');
  if (!grade.withReference) return failWith('This grade was made without a reference solution', 'no_reference');
  return grade as packageTypes.Grade & { report: packageTypes.GradeReport };
};

// The note's body: each difference, the developer's answer and Tutor's reply.
export const noteBody = (task: Pick<TaskDefinition, 'title'>, explanation: Explanation): string =>
  [
    `和参考实现的关键差异（${task.title}）。`,
    '',
    ...explanation.items.flatMap((item, index) => [
      `## ${index + 1}. ${item.difference}`,
      '',
      ...(item.file ? [`文件：${item.file}`, ''] : []),
      `我的解释：${item.answer ?? '（跳过）'}`,
      '',
      ...(item.feedback ? [item.feedback.correct ? '导师：对。' : `导师：漏了 ${item.feedback.missed ?? '一些要点'}`, ''] : []),
    ]),
  ].join('\n');

// The rubric item most of the differences are about, for the note's category.
const mainCategory = (items: packageTypes.ExplanationItem[]): string | null => {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
};

export const createExplanationService = (ctx: AppContext) => {
  const { store, backgroundRuns, requireTask } = ctx;

  const readReference = async (task: TaskDefinition): Promise<string> => {
    const patch = await fs.readFile(practice.referenceFileOf(ctx.repositories.dataDir(), task), 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') console.error('[explain] reference unreadable', error);
      return null;
    });
    return patch ?? failWith('There is no reference solution', 'no_reference');
  };

  // Writes `explanation` onto the grade it was started for; a regrade in between drops it.
  const save = async (id: string, gradeId: string, explanation: Explanation) => {
    const grade = store.get(id).grade;
    if (grade?.id !== gradeId) return null;
    return store.setGrade(id, { ...grade, explanation }, gradeId);
  };

  // One Tutor call in the background; `apply` turns its output into the next state.
  const runTutor = (
    id: string,
    gradeId: string,
    from: Explanation,
    call: (signal: AbortSignal) => Promise<{ output: unknown; costUsd: number | null }>,
    apply: (output: unknown) => Partial<Explanation>,
  ) => {
    const controller = backgroundRuns.start({ kind: 'explain', key: id, busy: 'grade', agent: () => 'tutor', label: ctx.packageLabel(id) });
    const settled = (async () => {
      let next: Explanation;
      try {
        const { output, costUsd } = await call(controller.signal);
        throwIfCancelled(controller.signal);
        next = { ...from, ...apply(output), error: null, costUsd: from.costUsd + (costUsd ?? 0) };
      } catch (error) {
        const cancelled = controller.signal.aborted;
        if (!cancelled) console.error('[explain] run failed', error);
        const info = asAgentError(error);
        next = {
          ...from,
          status: 'failed',
          error: cancelled ? { code: 'agent_cancelled', message: 'Tutor was cancelled' } : { code: info.code ?? 'agent_failed', message: info.message },
        };
      } finally {
        backgroundRuns.finish('explain', id, controller);
      }
      const written = await save(id, gradeId, next);
      console.debug(`[explain] ${from.status} done package=${id} status=${next.status} kept=${Boolean(written)}`);
    })();
    backgroundRuns.track(settled);
  };

  // Tutor picks the differences. Allowed once the reference may be read;
  // again after a failed pick.
  const start = async (id: string): Promise<packageTypes.TaskView> => {
    const task = requireTask(id);
    const state = store.get(id);
    const grade = requireGrade(state);
    const lock = practice.referenceLock({ referenceRun: state.referenceRun, review: toWireState(state).review }, practice.usedHintLevel(state));
    if (!lock?.unlocked) failWith('Pass every test of this package first, or use the hints up to L5', 'reference_locked');
    if (backgroundRuns.has('explain', id)) return ctx.viewOf(task, state);
    if (grade.explanation && !(grade.explanation.status === 'failed' && !grade.explanation.items.length))
      failWith('The differences were already picked', 'invalid_state');
    const reference = await readReference(task);
    const collected = await collectChanges(ctx.requireRoot(), ctx.requireBaseline(id), { ignore: reportIgnore(await ctx.runnableSteps().catch(() => [])) });
    const submission = collected.files.map((file) => ({ path: file.path, patch: file.patch }));
    const { pack: course } = await ctx.course(ctx.getConfig());
    // The grade's own rubric, so a category means what it meant when graded.
    const rubricCourse = grade.course ? { ...course, rubric: grade.course.rubric } : course;
    const { path: envPath } = await ctx.commandPath();
    const picking: Explanation = {
      status: 'picking',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      error: null,
      items: [],
      completed: false,
      noteId: null,
      costUsd: grade.explanation?.costUsd ?? 0,
    };
    await save(id, grade.id, picking);
    console.debug(`[explain] pick package=${id} files=${submission.length}`);
    const runner = ctx.runnerFor('tutor', { kind: 'package', id });
    runTutor(
      id,
      grade.id,
      picking,
      (signal) =>
        runner({
          prompt: tutorAgent.differencesPrompt({ task, submission, reference: practice.referenceForPrompt(reference) }),
          systemPrompt: tutorAgent.differencesSystemPrompt(rubricCourse),
          schema: tutorAgent.differencesSchema(rubricCourse),
          envPath,
          signal,
        }),
      (output) => {
        const differences = tutorAgent.validateDifferences(output, {
          course: rubricCourse,
          referencePaths: (state.referenceRun?.files ?? []).map((file) => file.path),
        });
        const items = differences.map((item) => ({ ...item, answer: null, feedback: null }));
        // Nothing worth explaining: done at once, with nothing to complete.
        return items.length ? { status: 'answering', items } : { status: 'done', items, finishedAt: new Date().toISOString() };
      },
    );
    return ctx.viewOf(task, store.get(id));
  };

  // The developer's answers, one per difference in order; null or blank
  // skips one. Tutor replies once to those answered; with none answered
  // the explanation ends without a reply.
  const answer = async (id: string, rawAnswers: unknown): Promise<packageTypes.TaskView> => {
    const task = requireTask(id);
    const state = store.get(id);
    const grade = requireGrade(state);
    const explanation = grade.explanation;
    const retry = explanation?.status === 'failed' && explanation.items.length > 0;
    if (!explanation || (explanation.status !== 'answering' && !retry)) failWith('There are no differences waiting for an answer', 'invalid_state');
    if (backgroundRuns.has('explain', id)) return ctx.viewOf(task, state);
    if (!Array.isArray(rawAnswers) || rawAnswers.length !== explanation.items.length)
      failWith(`answers must list ${explanation.items.length} items`, 'invalid_argument', 'answers');
    const answers = (rawAnswers as unknown[]).map((raw, index) => {
      if (raw !== null && typeof raw !== 'string') failWith(`answers[${index}] must be text or null`, 'invalid_argument', 'answers');
      const trimmed = (raw ?? '').trim();
      if ([...trimmed].length > MAX_ANSWER) failWith(`answers[${index}] is longer than ${MAX_ANSWER} characters`, 'invalid_argument', 'answers');
      return trimmed || null;
    });
    const items = explanation.items.map((item, index) => ({ ...item, answer: answers[index], feedback: null }));
    const answered = items.flatMap((item, index) => (item.answer ? [{ index, difference: item.difference, answer: item.answer }] : []));
    if (!answered.length) {
      await save(id, grade.id, { ...explanation, status: 'done', items, error: null, finishedAt: new Date().toISOString() });
      return ctx.viewOf(task, store.get(id));
    }
    const reference = await readReference(task);
    const { path: envPath } = await ctx.commandPath();
    const reviewing: Explanation = { ...explanation, status: 'reviewing', items, error: null };
    await save(id, grade.id, reviewing);
    console.debug(`[explain] answers package=${id} answered=${answered.length}/${items.length}`);
    const runner = ctx.runnerFor('tutor', { kind: 'package', id });
    runTutor(
      id,
      grade.id,
      reviewing,
      (signal) =>
        runner({
          prompt: tutorAgent.feedbackPrompt({ task, reference: practice.referenceForPrompt(reference), answers: answered }),
          systemPrompt: tutorAgent.FEEDBACK_SYSTEM_PROMPT,
          schema: tutorAgent.feedbackSchema(answered.length),
          envPath,
          signal,
        }),
      (output) => {
        const replies = tutorAgent.validateFeedback(output, answered.length);
        const byIndex = new Map(answered.map((entry, position) => [entry.index, replies[position]]));
        const withFeedback = items.map((item, index) => ({ ...item, feedback: byIndex.get(index) ?? null }));
        return { status: 'done', items: withFeedback, completed: true, finishedAt: new Date().toISOString() };
      },
    );
    return ctx.viewOf(task, store.get(id));
  };

  // Saves the finished explanation as one note: the package's concepts, the
  // grade's course, and the rubric item most differences are about.
  const saveNote = async (id: string): Promise<packageTypes.TaskView> => {
    const task = requireTask(id);
    const grade = requireGrade(store.get(id));
    const explanation = grade.explanation;
    if (explanation?.status !== 'done' || !explanation.items.length) failWith('Finish explaining the differences first', 'invalid_state');
    if (explanation.noteId) return ctx.viewOf(task, store.get(id));
    if (!ctx.notes) failWith('Notes are unavailable', 'unsupported');
    const repository = ctx.repositories.current;
    const saved = await ctx.notes.create(
      {
        title: toTitle(`参考实现为什么这样做：${task.title}`),
        body: noteBody(task, explanation),
        category: mainCategory(explanation.items),
        course: grade.course?.id ?? DEFAULT_COURSE_ID,
        concepts: task.concepts ?? [],
        tags: [],
        source: {
          repositoryId: repository?.id ?? null,
          repositoryName: repository ? path.basename(repository.root) : null,
          packageId: task.id,
          packageTitle: task.title,
          file: null,
          line: null,
        },
      },
      { autoRename: true },
    );
    await save(id, grade.id, { ...explanation, noteId: saved.note.id });
    console.debug(`[explain] note package=${id} note=${saved.note.id}`);
    return ctx.viewOf(task, store.get(id));
  };

  return { start, answer, saveNote };
};

export type ExplanationService = ReturnType<typeof createExplanationService>;
