// Repository channels: the registry, adding, moving and switching between
// repositories.
import path from 'node:path';

import { failWith, requireString } from '../coded_error.ts';
import * as git from '../git.ts';
import { readCounts } from '../repository_summary.ts';
import { countStatuses } from '../../shared/repository_counts.ts';
import { wrap } from './handler.ts';
import { CHANNELS } from '../../shared/ipc_channels.ts';
import type * as ipc from '../../shared/ipc_types.ts';
import type { AppContext } from '../app_context.ts';
import type { RepositoryEntry } from '../repositories.ts';
import type { IpcMainLike } from './handler.ts';

export const register = (ipcMain: IpcMainLike, ctx: AppContext) => {
  const { repositories, store, catalog } = ctx;

  const repositoryList = async (): Promise<ipc.RepositoryList> => {
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

  // [人工决策-2026-10-07 14:31:37] 切换仓库时有后台任务：渲染层先弹窗列出、用户确认后，这里取消全部任务再切；内存里同时只有一个仓库的数据。
  // Order matters: requirements must be open (their published packages are
  // the catalog) before the work package store loads, or saved progress is
  // dropped as unknown ids.
  const openRepository = async (id: string) => {
    await ctx.cancelAll();
    await ctx.flushStores();
    await repositories.open(id);
    const dir = repositories.dataDir();
    ctx.setConfig(await repositories.loadConfig());
    await ctx.requirements?.open(dir);
    await store.open(dir, catalog.listTasks());
    await ctx.releases?.open(dir);
    await ctx.activity?.open(dir);
    await ctx.tutor?.open(dir);
    ctx.activity?.prune().catch((error) => console.error('[activity] prune failed', error));
    ctx.repositoryOpened();
    console.debug(`[repositories] switched id=${id} packages=${catalog.listTasks().length}`);
  };

  ipcMain.handle(
    CHANNELS.repositoriesList,
    wrap(() => repositoryList()),
  );

  ipcMain.handle(
    CHANNELS.repositoriesBusy,
    wrap((): ipc.BusyRun[] => ctx.backgroundRuns.busy()),
  );

  ipcMain.handle(
    CHANNELS.repositoriesAdd,
    wrap(async (_event, rawRoot, open): Promise<ipc.RepositoryList> => {
      const { root } = await ctx.validateRoot(rawRoot);
      const hadCurrent = repositories.current !== null;
      const entry = await repositories.add(root);
      // The first repository adopts the unassigned data, which is what is loaded.
      if (!hadCurrent || open === true) await openRepository(entry.id);
      return repositoryList();
    }),
  );

  ipcMain.handle(
    CHANNELS.repositoriesSwitch,
    wrap(async (_event, rawId): Promise<ipc.RepositoryList> => {
      const id = requireString(rawId, 'id');
      if (!repositories.get(id)) return failWith(`Unknown repository: ${id}`, 'unknown_repository');
      if (repositories.current?.id !== id) await openRepository(id);
      return repositoryList();
    }),
  );

  ipcMain.handle(
    CHANNELS.repositoriesRelocate,
    wrap(async (_event, rawId, rawRoot): Promise<ipc.RepositoryList> => {
      const id = requireString(rawId, 'id');
      const { root } = await ctx.validateRoot(rawRoot);
      await repositories.relocate(id, root);
      if (repositories.current?.id === id) ctx.setConfig({ ...ctx.getConfig(), root });
      return repositoryList();
    }),
  );
};
