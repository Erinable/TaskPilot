// The renderer's only route to the filesystem, git and command execution.
// Every handler validates its arguments: the renderer is treated as untrusted
// input, since the content it displays originates from AI agents. This file
// only assembles the shared context, the domain services and the per-domain
// channel modules under ./ipc/.
import { createAppContext } from './app_context.ts';
import { createCodingRuntime } from './coding_runtime.ts';
import { createCodingService } from './coding_service.ts';
import { createPracticeService } from './practice_service.ts';
import { createReviewService } from './review_service.ts';
import * as activityIpc from './ipc/activity.ts';
import * as codingIpc from './ipc/coding.ts';
import * as commitIpc from './ipc/commit.ts';
import * as coursesIpc from './ipc/courses.ts';
import * as environmentIpc from './ipc/environment.ts';
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

export type IpcDeps = AppDeps & { coding?: CodingDeps };

export type IpcHandle = { shutdown: () => Promise<void> };

export const registerIpcHandlers = (ipcMain: IpcMainLike, deps: IpcDeps): IpcHandle => {
  const ctx = createAppContext(deps);
  const runtime = createCodingRuntime(ctx, deps.coding);
  // QA's verdict leads on to grading and the next coding round, which in
  // turn hand submissions back to QA; the services are wired late for that.
  const review = createReviewService(ctx, {
    onJudged: async (id) => {
      if (ctx.store.get(id).mode === 'practice') await practice.startGrade(id).catch((error) => console.error('[grade] could not start', error));
      coding.continueAfterReview(id);
    },
  });
  const practice = createPracticeService(ctx, runtime);
  const coding = createCodingService(ctx, runtime, { startReview: review.startReview });

  packagesIpc.register(ipcMain, ctx, { review, practice });
  codingIpc.register(ipcMain, ctx, { coding, runtime });
  workspaceIpc.register(ipcMain, ctx);
  settingsIpc.register(ipcMain, ctx, { runtime });
  requirementsIpc.register(ipcMain, ctx);
  activityIpc.register(ipcMain, ctx, { runtime });
  environmentIpc.register(ipcMain, ctx);
  releaseIpc.register(ipcMain, ctx);
  commitIpc.register(ipcMain, ctx);
  tutorIpc.register(ipcMain, ctx);
  notesIpc.register(ipcMain, ctx);
  coursesIpc.register(ipcMain, ctx);
  repositoriesIpc.register(ipcMain, ctx);

  return {
    // Cancels running agents and waits for their final writes.
    // On quit: nothing may still be writing once this resolves.
    shutdown: async () => {
      await ctx.cancelAll();
      await ctx.flushStores();
    },
  };
};
