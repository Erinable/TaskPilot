// The renderer's only route to the filesystem, git and command execution.
// Every handler validates its arguments: the renderer is treated as untrusted
// input, since the content it displays originates from AI agents. This file
// only assembles the shared context, the domain services and the per-domain
// channel modules under ./ipc/.
import { createAppContext } from './app_context.ts';
import { createCodingRuntime } from './coding_runtime.ts';
import { createCodingService } from './coding_service.ts';
import { createLabService } from './lab_service.ts';
import { createLabGenerationService } from './lab_generation_service.ts';
import { createCourseInterviewService } from './course_interview_service.ts';
import { createPracticeService } from './practice_service.ts';
import { createExplanationService } from './explanation_service.ts';
import { createReviewService } from './review_service.ts';
import * as activityIpc from './ipc/activity.ts';
import * as codingIpc from './ipc/coding.ts';
import * as commitIpc from './ipc/commit.ts';
import * as coursesIpc from './ipc/courses.ts';
import * as environmentIpc from './ipc/environment.ts';
import * as masteryIpc from './ipc/mastery.ts';
import * as notesIpc from './ipc/notes.ts';
import * as packagesIpc from './ipc/packages.ts';
import * as releaseIpc from './ipc/release.ts';
import * as repositoriesIpc from './ipc/repositories.ts';
import * as requirementsIpc from './ipc/requirements.ts';
import * as settingsIpc from './ipc/settings.ts';
import * as tutorIpc from './ipc/tutor.ts';
import * as workspaceIpc from './ipc/workspace.ts';
import type { AppDeps } from './app_context.ts';
import type { CodingDeps } from './coding_runtime.ts';
import type { IpcMainLike } from './ipc/handler.ts';
import type { LabService } from './lab_service.ts';
import type { LabGenerationService } from './lab_generation_service.ts';
import { sandboxGrader } from './lab_verify.ts';
import type { Grader } from './lab_verify.ts';

// `labGrader` replaces the sandboxed `make grade` of the lab self-check and
// of a lab's hidden tests at review (tests).
export type IpcDeps = AppDeps & { coding?: CodingDeps; labGrader?: Grader };

// `labs` and `labGeneration` are for main-process callers (the self-check);
// the renderer never hands TaskPilot a lab or reads one, since a lab carries
// the private parts.
export type IpcHandle = { shutdown: () => Promise<void>; labs: LabService; labGeneration: LabGenerationService };

export const registerIpcHandlers = (ipcMain: IpcMainLike, deps: IpcDeps): IpcHandle => {
  const ctx = createAppContext(deps);
  const runtime = createCodingRuntime(ctx, deps.coding);
  const grader = deps.labGrader ?? sandboxGrader();
  // QA's verdict leads on to grading and the next coding round, which in
  // turn hand submissions back to QA; the services are wired late for that.
  const review = createReviewService(ctx, {
    onJudged: async (id) => {
      if (ctx.store.get(id).mode === 'practice') await practice.startGrade(id).catch((error) => console.error('[grade] could not start', error));
      coding.continueAfterReview(id);
    },
    grader,
  });
  const practice = createPracticeService(ctx, runtime);
  const coding = createCodingService(ctx, runtime, { startReview: review.startReview });

  packagesIpc.register(ipcMain, ctx, { review, practice, explanation: createExplanationService(ctx) });
  codingIpc.register(ipcMain, ctx, { coding, runtime });
  workspaceIpc.register(ipcMain, ctx);
  settingsIpc.register(ipcMain, ctx, { runtime });
  const labGeneration = createLabGenerationService(ctx, { grader });
  requirementsIpc.register(ipcMain, ctx, { courseInterview: createCourseInterviewService(ctx), labGeneration });
  activityIpc.register(ipcMain, ctx, { runtime });
  environmentIpc.register(ipcMain, ctx);
  releaseIpc.register(ipcMain, ctx);
  commitIpc.register(ipcMain, ctx);
  tutorIpc.register(ipcMain, ctx);
  notesIpc.register(ipcMain, ctx);
  coursesIpc.register(ipcMain, ctx);
  masteryIpc.register(ipcMain, ctx);
  repositoriesIpc.register(ipcMain, ctx);

  return {
    labs: createLabService(ctx),
    labGeneration,
    // Cancels running agents and waits for their final writes.
    // On quit: nothing may still be writing once this resolves.
    shutdown: async () => {
      await ctx.cancelAll();
      await ctx.flushStores();
    },
  };
};
