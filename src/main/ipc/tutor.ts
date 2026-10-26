// Tutor channels (../agents/tutor.ts): one step explained, on request.
import { asAgentError, failWith, requireString } from '../coded_error.ts';
import * as tutorAgent from '../agents/tutor.ts';
import { readTracked } from '../repo_reader.ts';
import { throwIfCancelled } from '../agents/pipeline.ts';
import { wrap } from './handler.ts';
import { CHANNELS } from '../../shared/ipc_channels.ts';
import type * as envelopeTypes from '../../shared/ipc/envelope.ts';
import type * as tutorTypes from '../../shared/ipc/tutor.ts';
import type { AppContext } from '../app_context.ts';
import type { IpcMainLike } from './handler.ts';

const tutorKey = (id: string, stepIndex: number) => `${id}#${stepIndex}`;

export const register = (ipcMain: IpcMainLike, ctx: AppContext) => {
  const { backgroundRuns } = ctx;

  // One in-flight answer per package step; failures are kept until retried.
  const tutorFailures = new Map<string, envelopeTypes.ErrorInfo>();
  ctx.onCancelAll(() => tutorFailures.clear());

  const requireTutor = () => {
    if (!ctx.tutor) return failWith('Tutor is unavailable', 'unsupported');
    return ctx.tutor;
  };

  const requireStep = (rawId: unknown, rawIndex: unknown) => {
    const task = ctx.requireTask(requireString(rawId, 'id'));
    if (!Number.isInteger(rawIndex) || (rawIndex as number) < 0 || (rawIndex as number) >= task.steps.length) {
      failWith('stepIndex is not a step of this package', 'invalid_step');
    }
    return { task, stepIndex: rawIndex as number, step: task.steps[rawIndex as number] };
  };

  const tutorState = (id: string, stepIndex: number, step: string): tutorTypes.TutorState => {
    const key = tutorKey(id, stepIndex);
    if (backgroundRuns.has('tutor', key)) return { status: 'running', answer: null, error: null, costUsd: 0 };
    const saved = requireTutor().get(id, stepIndex, step);
    if (saved) return { status: 'done', answer: saved.answer, error: null, costUsd: saved.costUsd };
    const error = tutorFailures.get(key);
    return error ? { status: 'failed', answer: null, error, costUsd: 0 } : { status: 'idle', answer: null, error: null, costUsd: 0 };
  };

  ipcMain.handle(
    CHANNELS.tutorGet,
    wrap((_event, rawId, rawIndex): tutorTypes.TutorState => {
      const { task, stepIndex, step } = requireStep(rawId, rawIndex);
      return tutorState(task.id, stepIndex, step);
    }),
  );

  // A saved answer is returned as is: asking again costs nothing.
  ipcMain.handle(
    CHANNELS.tutorAsk,
    wrap(async (_event, rawId, rawIndex): Promise<tutorTypes.TutorState> => {
      const store = requireTutor();
      const { task, stepIndex, step } = requireStep(rawId, rawIndex);
      const tutorRunner = ctx.runnerFor('tutor', { kind: 'package', id: task.id });
      const key = tutorKey(task.id, stepIndex);
      const current = tutorState(task.id, stepIndex, step);
      if (current.status === 'running' || current.status === 'done') return current;
      // Fixed at the start, like the other runs.
      const config = ctx.getConfig();
      const { root } = config;
      const controller = backgroundRuns.start({ kind: 'tutor', key, busy: 'tutor', agent: () => 'tutor', label: ctx.packageLabel(task.id) });
      tutorFailures.delete(key);
      const { path: envPath } = await ctx.commandPath();
      console.debug(`[tutor] ask package=${task.id} step=${stepIndex}`);
      backgroundRuns.track(
        (async () => {
          try {
            // Scope files as committed; ones the step creates are missing.
            const read = root ? await readTracked(root, task.fileScope.slice(0, tutorAgent.MAX_TUTOR_FILES)) : { files: [], skipped: [] };
            const missing = read.skipped.filter((item) => item.reason === 'not_tracked').map((item) => item.path);
            const profile = await ctx.profile(config);
            const course = await ctx.course(config);
            throwIfCancelled(controller.signal);
            const { output, costUsd } = await tutorRunner({
              prompt: tutorAgent.tutorPrompt({ task, stepIndex, sources: read.files, missing, profile }),
              systemPrompt: tutorAgent.systemPrompt(course.pack),
              schema: tutorAgent.TUTOR_SCHEMA,
              envPath,
              signal: controller.signal,
            });
            throwIfCancelled(controller.signal);
            const answer = tutorAgent.validateAnswer(output);
            await store.put({ packageId: task.id, stepIndex, step, answer, costUsd: costUsd ?? 0, createdAt: new Date().toISOString() });
          } catch (error) {
            const cancelled = controller.signal.aborted;
            if (!cancelled) console.error('[tutor] run failed', error);
            const info = asAgentError(error);
            tutorFailures.set(
              key,
              cancelled ? { code: 'agent_cancelled', message: 'Tutor was cancelled' } : { code: info.code ?? 'agent_failed', message: info.message },
            );
          } finally {
            backgroundRuns.finish('tutor', key, controller);
          }
        })(),
      );
      return tutorState(task.id, stepIndex, step);
    }),
  );

  ipcMain.handle(
    CHANNELS.tutorCancel,
    wrap((_event, rawId, rawIndex): boolean => {
      const { task, stepIndex } = requireStep(rawId, rawIndex);
      const controller = backgroundRuns.get('tutor', tutorKey(task.id, stepIndex));
      controller?.abort();
      return Boolean(controller);
    }),
  );
};
