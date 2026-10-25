// Activity and cost channels: the feed, the team's presence and spend, the
// cost report and its prices, and the engineering map.
import { failWith } from '../coded_error.ts';
import * as git from '../git.ts';
import * as workspace from '../workspace.ts';
import { RETENTION_DAYS } from '../activity_log.ts';
import { buildCostReport } from '../cost_report.ts';
import { estimateMicros, loadPrices, priceFor, syncPrices } from '../model_prices.ts';
import { buildEngineeringMap, MAX_TREE_FILES } from '../engineering_map.ts';
import { indexEntries } from '../repo_reader.ts';
import { supportsAgentConfig, TEAM_AGENT_IDS } from '../../shared/agent_runtime.ts';
import { wrap } from './handler.ts';
import { CHANNELS } from '../../shared/ipc_channels.ts';
import type * as ipc from '../../shared/ipc_types.ts';
import type { PriceTable } from '../model_prices.ts';
import type { CostRow } from '../cost_rollup.ts';
import type { AppContext } from '../app_context.ts';
import type { CodingRuntime } from '../coding_runtime.ts';
import type { IpcMainLike } from './handler.ts';

// The team's analysis agents; Coding Agent's availability is its runtime probe.
const ANALYSIS_AGENTS = TEAM_AGENT_IDS.filter((agent) => agent !== 'coding-agent');

// How long a found or missing CLI is trusted; installing one shows up after this.
const EXECUTABLE_TTL_MS = 60_000;

const estimateRow = (table: PriceTable | null) => (row: CostRow) => {
  const price = priceFor(table, row.provider, row.model);
  return price ? estimateMicros(price, row.tokens) : null;
};

export const register = (ipcMain: IpcMainLike, ctx: AppContext, { runtime }: { runtime: CodingRuntime }) => {
  const { configDir } = ctx;

  const requireActivity = () => ctx.activity ?? failWith('Activity is unavailable', 'unsupported');

  // Prices stay in memory once read; only a sync replaces them.
  let prices: Promise<PriceTable | null> | null = null;
  const currentPrices = () =>
    (prices ??= loadPrices(configDir).catch((error) => {
      // A read failure is retried on the next request instead of sticking.
      prices = null;
      throw error;
    }));

  // Whether each CLI is on the PATH, keyed by CLI and PATH so a settings or
  // PATH change asks again at once; the renderer polls every 15 seconds.
  const executables = new Map<string, { found: Promise<boolean>; at: number }>();
  const isInstalled = (cli: string, envPath: string) => {
    const key = `${cli}\u0000${envPath}`;
    const now = Date.now();
    const cached = executables.get(key);
    if (cached && now - cached.at < EXECUTABLE_TTL_MS) return cached.found;
    // Entries of an earlier PATH or CLI are dropped, so the map stays small.
    for (const [entryKey, entry] of executables) if (now - entry.at >= EXECUTABLE_TTL_MS) executables.delete(entryKey);
    const found = workspace.resolveExecutable(cli, { envPath }).then(Boolean);
    executables.set(key, { found, at: now });
    return found;
  };

  // The feed, the week's metrics, each member's newest events and spend, and
  // who on the team is busy. Everything but presence comes from the log's
  // in-memory summary, so a poll reads no day files.
  ipcMain.handle(
    CHANNELS.activityOverview,
    wrap(async (): Promise<ipc.ActivityOverview> => {
      const activity = requireActivity();
      const settings = ctx.getPreferences().agents;
      const { path: envPath } = await ctx.commandPath();
      const [summary, coding, analysis] = await Promise.all([
        currentPrices().then((table) => activity.overview(estimateRow(table))),
        runtime.codingStatus(),
        Promise.all(
          ANALYSIS_AGENTS.map(async (agent) => {
            const config = settings[agent];
            return [agent, supportsAgentConfig(agent, config) && (await isInstalled(config.cli, envPath))] as const;
          }),
        ),
      ]);
      const availableByAgent = { ...Object.fromEntries(analysis), 'coding-agent': coding.available } as ipc.TeamStatus['availableByAgent'];
      const work = ctx.backgroundRuns.work();
      return {
        recent: summary.recent,
        metrics: summary.metrics,
        team: {
          available: Object.values(availableByAgent).some(Boolean),
          availableByAgent,
          busy: [...new Set(work.map((item) => item.agent))],
          work,
        },
        costs: summary.costs,
        teamRecent: summary.teamRecent,
        timeZone: activity.timeZone,
      };
    }),
  );

  ipcMain.handle(
    CHANNELS.costsReport,
    wrap(async (_event, rawDays): Promise<ipc.CostReport> => {
      const activity = requireActivity();
      if (rawDays !== 7 && rawDays !== 30 && rawDays !== 90) failWith('days must be 7, 30 or 90', 'invalid_argument', 'days');
      const [records, rollup, table] = await Promise.all([activity.window(RETENTION_DAYS), activity.rollup(), currentPrices()]);
      return buildCostReport({
        days: rawDays as ipc.CostRange,
        records,
        rollup,
        prices: table,
        now: new Date(),
        timeZone: activity.timeZone,
        titleOf: (kind, id) => (kind === 'package' ? (ctx.catalog.getTask(id)?.title ?? id) : ctx.requirementTitle(id)),
      });
    }),
  );
  // [人工决策-2026-10-13 16:52:32] 只在用户点「同步价格」时联网，只下载，不上传任何数据。
  ipcMain.handle(
    CHANNELS.costsSyncPrices,
    wrap(async (): Promise<{ syncedAt: string }> => {
      const activity = requireActivity();
      const [records, rollup] = await Promise.all([activity.window(RETENTION_DAYS), activity.rollup()]);
      // Exact prices are kept only for providers TaskPilot has actually used.
      const providers = new Set(
        [
          ...records.flatMap((record) => (record.kind === 'agent_cost' && record.call?.provider ? [record.call.provider] : [])),
          ...rollup.map((row) => row.provider),
        ]
          .filter((provider): provider is string => Boolean(provider))
          .map((provider) => provider.toLowerCase()),
      );
      const table = await syncPrices(configDir, providers);
      prices = Promise.resolve(table);
      return { syncedAt: table.syncedAt };
    }),
  );

  // The full feed, a few business days per page.
  ipcMain.handle(
    CHANNELS.activityPage,
    wrap(async (_event, before): Promise<ipc.ActivityPage> => {
      const activity = requireActivity();
      // A day key from an earlier page; anything else starts from today.
      const cursor = typeof before === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(before) ? before : null;
      const page = await activity.page({ before: cursor, minEvents: 50 });
      return { ...page, timeZone: activity.timeZone, retentionDays: RETENTION_DAYS };
    }),
  );

  // Architect's summaries merged by file, beside the tracked tree. Without a
  // workspace the summaries still show, with unknown freshness.
  ipcMain.handle(
    CHANNELS.engineeringMap,
    wrap(async (): Promise<ipc.EngineeringMap> => {
      const root = ctx.getConfig().root;
      const [index, paths] = root ? await Promise.all([indexEntries(root), git.listFiles(root, { limit: MAX_TREE_FILES + 1 })]) : [null, []];
      return buildEngineeringMap(ctx.requirements?.list() ?? [], index, paths);
    }),
  );
};
