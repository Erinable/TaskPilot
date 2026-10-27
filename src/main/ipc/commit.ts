// Committing a finished package (../git_commit.ts).
import { failWith, requireString } from '../coded_error.ts';
import * as gitCommit from '../git_commit.ts';
import { registerContract } from './handler.ts';
import { commitContract } from '../../shared/ipc/commit.ts';
import type * as packageTypes from '../../shared/ipc/packages.ts';
import type { AppContext } from '../app_context.ts';
import type { TaskDefinition } from '../tasks.ts';
import type { IpcMainLike } from './handler.ts';

// Only once the work is accepted: committing earlier would put unreviewed
// code in history, and claiming the next package wants a clean tree.
const COMMITTABLE: packageTypes.WorkPackageStatus[] = ['accepting', 'done'];

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

  registerContract(ipcMain, commitContract, {
    preview: async (rawId) => {
      const task = requireCommittable(requireString(rawId, 'id'));
      const { committable, skipped } = await gitCommit.preview(ctx.requireRoot(), task.fileScope);
      return { files: committable, skipped, message: suggestedMessage(task) };
    },
    create: async (rawId, rawMessage, rawFiles) => {
      const task = requireCommittable(requireString(rawId, 'id'));
      const message = gitCommit.validateMessage(rawMessage);
      if (!Array.isArray(rawFiles) || rawFiles.some((file) => typeof file !== 'string')) failWith('files must be a list of paths', 'invalid_argument');
      const files = rawFiles as string[];
      const commit = await gitCommit.commitPaths(ctx.requireRoot(), task.fileScope, files, message);
      console.debug(`[commit] package=${task.id} files=${files.length} commit=${commit.slice(0, 8)}`);
      return { commit, files };
    },
  });
};
