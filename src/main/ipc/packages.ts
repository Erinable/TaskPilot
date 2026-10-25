// Work package channels: the queue, transitions and step progress, and the
// agents that judge a package (QA, Architect's ruling, the baseline).
import { asAgentError, failWith, requireString } from '../coded_error.ts';
import * as git from '../git.ts';
import { toWireState } from '../app_context.ts';
import { wrap } from './handler.ts';
import { CHANNELS } from '../../shared/ipc_channels.ts';
import type * as packageTypes from '../../shared/ipc/packages.ts';
import type { AppContext } from '../app_context.ts';
import type { PracticeService } from '../practice_service.ts';
import type { ReviewService } from '../review_service.ts';
import type { TransitionName } from '../work_package_status.ts';
import type { DeviationInput } from '../work_package_store.ts';
import type { IpcMainLike } from './handler.ts';

const EXECUTION_MODES: unknown[] = ['practice', 'ai', 'self'] satisfies packageTypes.ExecutionMode[];

export const register = (ipcMain: IpcMainLike, ctx: AppContext, { review, practice }: { review: ReviewService; practice: PracticeService }) => {
  const { store, backgroundRuns, requireTask } = ctx;

  // Aborts one run of `kind` for a package, if any; true when there was one.
  const abortRun = (kind: 'review' | 'adjudication', id: string) => {
    const controller = backgroundRuns.get(kind, id);
    if (!controller) return false;
    controller.abort();
    return true;
  };

  // The developer starts a package before one of its dependencies is done.
  ipcMain.handle(
    CHANNELS.waiveDependency,
    wrap(async (_event, rawId, rawDependency): Promise<packageTypes.TaskView> => {
      const id = requireString(rawId, 'id');
      const dependency = requireString(rawDependency, 'dependency');
      const task = requireTask(id);
      if (!(task.dependsOn ?? []).includes(dependency)) failWith('Not a dependency of this package', 'invalid_argument', 'dependency');
      return ctx.viewOf(task, await store.waiveDependency(id, dependency));
    }),
  );

  ipcMain.handle(
    CHANNELS.listTasks,
    wrap((): packageTypes.TaskView[] => {
      const state = store.all();
      return ctx.catalog.listTasks().map((task) => ctx.viewOf(store.effective(task), state[task.id]));
    }),
  );

  ipcMain.handle(
    CHANNELS.getTask,
    wrap((_event, id): packageTypes.TaskView => {
      const checked = requireString(id, 'id');
      return ctx.viewOf(requireTask(checked), store.get(checked));
    }),
  );

  // Re-measuring is for a package claimed on a dirty tree, once it is clean.
  // It is only allowed before the developer has submitted anything.
  ipcMain.handle(
    CHANNELS.baselineMeasure,
    wrap(async (_event, rawId): Promise<packageTypes.TaskView> => {
      const id = requireString(rawId, 'id');
      ctx.requireBaseline(id);
      const state = store.get(id);
      if (state.status !== 'in_progress') failWith('Baselines can only be measured while the package is in progress', 'invalid_state');
      if (backgroundRuns.has('baseline', id)) failWith('The baseline is already being measured', 'baseline_running');
      review.measureBaseline(id);
      return ctx.viewOf(requireTask(id), store.get(id));
    }),
  );

  // `actor` is fixed to 'human': anything arriving from the renderer is a
  // human action by definition, so the renderer cannot claim to be an agent.
  ipcMain.handle(
    CHANNELS.transition,
    wrap(async (_event, rawId, rawName, options): Promise<packageTypes.WorkPackageState> => {
      const id = requireString(rawId, 'id');
      const name = requireString(rawName, 'name');
      const extra: { baseline?: string; deviation?: DeviationInput; mode?: packageTypes.ExecutionMode } = {};
      if (name === 'claim') {
        const mode = (options as packageTypes.TransitionOptions | null | undefined)?.mode;
        if (mode !== undefined && !EXECUTION_MODES.includes(mode)) failWith('Unknown execution mode', 'invalid_argument', 'mode');
        extra.mode = mode;
        // [人工决策-2026-10-14] 前置包没完成就不能领取；解除依赖要人明确操作。
        const blocking = ctx.dependenciesOf(requireTask(id), store.get(id)).filter((dependency) => dependency.blocking);
        if (blocking.length) failWith(`Waiting for ${blocking.map((dependency) => dependency.title ?? dependency.id).join(', ')}`, 'dependencies_pending');
        extra.baseline = await git.head(ctx.requireRoot());
      }
      // The store validates the deviation it is given.
      if (name === 'report_deviation') extra.deviation = (options as { deviation?: DeviationInput } | null | undefined)?.deviation;
      if (name === 'release') {
        backgroundRuns.get('baseline', id)?.abort();
        backgroundRuns.get('reference', id)?.abort();
        backgroundRuns.get('grade', id)?.abort();
      }
      // store.transition() rejects names that are not transitions.
      const before = store.get(id).status;
      const entry = await store.transition(id, name as TransitionName, 'human', extra);
      ctx.recordTransition(id, before, entry, name as packageTypes.HumanTransition, 'human');
      if (name === 'claim') {
        review.measureBaseline(id);
        if (entry.mode === 'practice') practice.startReference(id);
        return toWireState(entry);
      }
      if (name === 'report_deviation' || name === 'override_dismissal') {
        // The report stands even if Architect cannot start; it can be retried.
        try {
          return await review.startAdjudication(id);
        } catch (error) {
          await store
            .beginAdjudication(id)
            .then(() => store.failAdjudication(id, asAgentError(error)))
            .catch(() => {});
          return toWireState(store.get(id));
        }
      }
      if (name !== 'submit_for_review') return toWireState(entry);
      // The submission stands even if QA cannot start (no workspace, say);
      // the failure is recorded on the review and the user can retry.
      try {
        return await review.startReview(id);
      } catch (error) {
        await store
          .beginReview(id)
          .then(() => store.failReview(id, asAgentError(error)))
          .catch(() => {});
        return toWireState(store.get(id));
      }
    }),
  );

  ipcMain.handle(
    CHANNELS.reviewRetry,
    wrap((_event, id): Promise<packageTypes.WorkPackageState> => review.startReview(requireString(id, 'id'))),
  );

  ipcMain.handle(
    CHANNELS.reviewCancel,
    wrap((_event, id): boolean => abortRun('review', requireString(id, 'id'))),
  );

  ipcMain.handle(
    CHANNELS.deviationRetry,
    wrap((_event, id): Promise<packageTypes.WorkPackageState> => review.startAdjudication(requireString(id, 'id'))),
  );

  ipcMain.handle(
    CHANNELS.deviationCancel,
    wrap((_event, id): boolean => abortRun('adjudication', requireString(id, 'id'))),
  );

  // The store rejects a stepIndex that is not a non-negative integer.
  ipcMain.handle(
    CHANNELS.setStepDone,
    wrap((_event, id, stepIndex, done): Promise<packageTypes.WorkPackageState> =>
      store.setStepDone(requireString(id, 'id'), stepIndex as number, done === true).then(toWireState),
    ),
  );

  // Practice: the reference is shown after the first submission, and a
  // grade can be asked for again.
  ipcMain.handle(
    CHANNELS.referenceGet,
    wrap((_event, rawId): Promise<string> => practice.revealReference(requireString(rawId, 'id'))),
  );

  ipcMain.handle(
    CHANNELS.gradeStart,
    wrap((_event, rawId, skipReference): Promise<packageTypes.TaskView> => {
      if (typeof skipReference !== 'boolean') failWith('skipReference must be boolean', 'invalid_argument', 'skipReference');
      return practice.startGrade(requireString(rawId, 'id'), { force: true, skipReference });
    }),
  );
};
