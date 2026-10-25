// Committing a finished package (../git_commit.ts).
import { failWith, requireString } from '../coded_error.ts';
import * as gitCommit from '../git_commit.ts';
import { wrap } from './handler.ts';
import { CHANNELS } from '../../shared/ipc_channels.ts';
import type * as ipc from '../../shared/ipc_types.ts';
import type { AppContext } from '../app_context.ts';
import type { TaskDefinition } from '../tasks.ts';
import type { IpcMainLike } from './handler.ts';

// Only once the work is accepted: committing earlier would put unreviewed
// code in history, and claiming the next package wants a clean tree.
const COMMITTABLE: ipc.WorkPackageStatus[] = ['accepting', 'done'];

// The package title as the subject (git's 72-column habit), its id below.
const suggestedMessage = (task: TaskDefinition) => {
  const subject = task.title.length > gitCommit.MAX_SUBJECT ? `${task.title.slice(0, gitCommit.MAX_SUBJECT - 1)}…` : task.title;
  return `${subject}\n\nTaskPilot 工作包 ${task.id}`;
};

export const register = (ipcMain: IpcMainLike, ctx: AppContext) => {
  const requireCommittable = (id: string) => {
    const task = ctx.requireTask(id);
    if (!COMMITTABLE.includes(ctx.store.get(id).status)) failWith('Only an accepted package can be committed', 'invalid_state');
    return task;
  };

  ipcMain.handle(
    CHANNELS.commitPreview,
    wrap(async (_event, rawId): Promise<ipc.CommitPreview> => {
      const task = requireCommittable(requireString(rawId, 'id'));
      const { committable, skipped } = await gitCommit.preview(ctx.requireRoot(), task.fileScope);
      return { files: committable, skipped, message: suggestedMessage(task) };
    }),
  );

  ipcMain.handle(
    CHANNELS.commitCreate,
    wrap(async (_event, rawId, rawMessage, rawFiles): Promise<ipc.CommitResult> => {
      const task = requireCommittable(requireString(rawId, 'id'));
      const message = gitCommit.validateMessage(rawMessage);
      if (!Array.isArray(rawFiles) || rawFiles.some((file) => typeof file !== 'string')) failWith('files must be a list of paths', 'invalid_argument');
      const files = rawFiles as string[];
      const commit = await gitCommit.commitPaths(ctx.requireRoot(), task.fileScope, files, message);
      console.debug(`[commit] package=${task.id} files=${files.length} commit=${commit.slice(0, 8)}`);
      return { commit, files };
    }),
  );
};
