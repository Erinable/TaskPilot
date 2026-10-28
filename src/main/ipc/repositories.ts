// Repository channels: the registry, adding, moving and switching between
// repositories.
import path from 'node:path';

import { failWith, requireString } from '../infrastructure/coded_error.ts';
import * as git from '../repository/git.ts';
import { readCounts } from '../repository/repository_summary.ts';
import { countStatuses } from '../../shared/repository_counts.ts';
import { registerContract } from './handler.ts';
import { repositoriesContract } from '../../shared/ipc/repositories.ts';
import type * as repositoryTypes from '../../shared/ipc/repositories.ts';
import type { AppContext } from '../app/app_context.ts';
import type { RepositoryEntry } from '../repository/repositories.ts';
import type { IpcMainLike } from './handler.ts';

export const register = (ipcMain: IpcMainLike, ctx: AppContext) => {
  const { repositories, store, catalog, openRepository } = ctx;

  const repositoryList = async (): Promise<repositoryTypes.RepositoryList> => {
    const current = repositories.current?.id ?? null;
    const entries = repositories.list();
    const present = await Promise.all(entries.map((entry) => git.isRepo(entry.root).catch(() => false)));
    // The open repository from memory, so the counts match the queue.
    const openCounts = () => {
      const states = store.all();
      return countStatuses(catalog.listTasks().map((task) => states[task.id]?.status ?? task.status));
    };
    const counts = await Promise.all(entries.map((entry) => (entry.id === current ? openCounts() : readCounts(repositories.dataDir(entry.id)))));
    return {
      current,
      repositories: entries.map((entry: RepositoryEntry, index) => ({
        id: entry.id,
        root: entry.root,
        name: path.basename(entry.root),
        lastOpenedAt: entry.lastOpenedAt,
        current: entry.id === current,
        missing: !present[index],
        counts: counts[index],
      })),
    };
  };

  registerContract(ipcMain, repositoriesContract, {
    list: () => repositoryList(),

    busy: (): repositoryTypes.BusyRun[] => ctx.backgroundRuns.busy(),

    add: async (rawRoot, open): Promise<repositoryTypes.RepositoryList> => {
      const { root } = await ctx.validateRoot(rawRoot);
      const hadCurrent = repositories.current !== null;
      const entry = await repositories.add(root);
      // The first repository adopts the unassigned data, which is what is loaded.
      if (!hadCurrent || open === true) await openRepository(entry.id);
      return repositoryList();
    },

    switch: async (rawId): Promise<repositoryTypes.RepositoryList> => {
      const id = requireString(rawId, 'id');
      if (!repositories.get(id)) return failWith(`Unknown repository: ${id}`, 'unknown_repository');
      if (repositories.current?.id !== id) await openRepository(id);
      return repositoryList();
    },

    relocate: async (rawId, rawRoot): Promise<repositoryTypes.RepositoryList> => {
      const id = requireString(rawId, 'id');
      const { root } = await ctx.validateRoot(rawRoot);
      await repositories.relocate(id, root);
      if (repositories.current?.id === id) ctx.setConfig({ ...ctx.getConfig(), root });
      if (repositories.current?.id === id) ctx.changed('workspace');
      return repositoryList();
    },
  });
};
