// Settings channels: preferences, the PATH commands run with, app data, and
// the agents' runtimes and models.
import path from 'node:path';

import { failWith } from '../coded_error.ts';
import * as preferences from '../preferences.ts';
import * as workspace from '../workspace.ts';
import { REGISTRY_FILENAME, REPO_FILES } from '../repositories.ts';
import { env as appEnv } from '../env.ts';
import { AGENT_IDS, CLI_IDS } from '../../shared/agent_runtime.ts';
import { wrap } from './handler.ts';
import { CHANNELS } from '../../shared/ipc_channels.ts';
import type * as ipc from '../../shared/ipc_types.ts';
import type { CliProbeResult } from '../agents/cli_runner.ts';
import type { AppContext } from '../app_context.ts';
import type { CodingRuntime } from '../coding_runtime.ts';
import type { IpcMainLike } from './handler.ts';

const isPathSource = (value: unknown): value is ipc.PathSource => preferences.PATH_SOURCES.includes(value as ipc.PathSource);

export const register = (ipcMain: IpcMainLike, ctx: AppContext, { runtime }: { runtime: CodingRuntime }) => {
  const { configDir, getPreferences, pathResolver, store, probeAgent, checkSignIn } = ctx;

  ipcMain.handle(
    CHANNELS.preferencesGet,
    wrap((): ipc.Preferences => preferences.toView(getPreferences())),
  );

  // preferences.save() validates the raw value strictly.
  ipcMain.handle(
    CHANNELS.preferencesSet,
    wrap(async (_event, raw): Promise<ipc.Preferences> => {
      const previous = getPreferences();
      const saved = await preferences.save(configDir, raw);
      ctx.setPreferences(saved);
      // Switching the PATH source should take effect without a restart.
      if (saved.environment.pathSource !== previous.environment.pathSource) pathResolver.refresh();
      ctx.onPreferencesChanged?.(saved, previous);
      return preferences.toView(saved);
    }),
  );

  // Reports which PATH verification commands will use and what it contains.
  // `source` lets the page preview a choice before saving it.
  ipcMain.handle(
    CHANNELS.environmentInfo,
    wrap(async (_event, rawOptions): Promise<ipc.EnvironmentInfo> => {
      const options = rawOptions as { source?: unknown; refresh?: unknown } | null | undefined;
      const requested = options?.source ?? getPreferences().environment.pathSource;
      if (!isPathSource(requested)) return failWith(`Unknown PATH source: ${requested}`, 'invalid_argument');
      if (options?.refresh === true) pathResolver.refresh();
      const resolved = await pathResolver.resolve(requested);
      const entries = resolved.path.split(path.delimiter).filter(Boolean);
      return {
        requested,
        source: resolved.source,
        error: resolved.error,
        shell: appEnv.shell,
        entries,
        inheritedCount: pathResolver.inherited.split(path.delimiter).filter(Boolean).length,
        platform: process.platform,
        versions: { app: ctx.appVersion ?? null, electron: process.versions.electron ?? null, node: process.versions.node },
      };
    }),
  );

  ipcMain.handle(
    CHANNELS.dataInfo,
    wrap((): ipc.DataInfo => {
      const repoDir = path.relative(configDir, ctx.repositories.dataDir());
      return {
        configDir,
        files: [preferences.PREFERENCES_FILENAME, REGISTRY_FILENAME, ...REPO_FILES.map((name) => path.join(repoDir, name))],
        packages: store.summary(),
      };
    }),
  );

  // Only resets execution progress; workspace config and preferences stay.
  ipcMain.handle(
    CHANNELS.dataResetProgress,
    wrap(async (): Promise<ipc.PackageSummary> => {
      // Every background run would otherwise write its result over the reset;
      // a coding round or baseline left running could hold it for minutes.
      await ctx.cancelAll();
      await store.reset();
      return store.summary();
    }),
  );

  ipcMain.handle(
    CHANNELS.dataReveal,
    wrap(async (): Promise<true> => {
      if (!ctx.shell.revealPath) return failWith('Opening the folder is unavailable', 'unsupported');
      await ctx.shell.revealPath(configDir);
      return true;
    }),
  );

  // Requirements need both configured planning runtimes, never an unrelated
  // hard-coded executable. The settings page probes every role separately.
  ipcMain.handle(
    CHANNELS.agentStatus,
    wrap(async (): Promise<ipc.AgentStatus> => {
      const settings = getPreferences().agents;
      const { path: envPath } = await ctx.commandPath();
      const codingCli = settings['coding-agent'].cli;
      const [product, architect, codingInstalled] = await Promise.all([
        probeAgent(settings['product-lead'], envPath),
        probeAgent(settings.architect, envPath),
        workspace.resolveExecutable(codingCli, { envPath }).then(Boolean),
      ]);
      const available = product.available && architect.available;
      // One check per CLI, shared when analysis and coding use the same one.
      const signIns = new Map<string, Promise<ipc.CliSignIn>>();
      const signInOf = (cli: typeof codingCli) => signIns.get(cli) ?? signIns.set(cli, checkSignIn(cli, { envPath })).get(cli)!;
      const [analysisSignIn, codingSignIn] = await Promise.all([
        available ? signInOf(settings['product-lead'].cli) : null,
        codingInstalled ? signInOf(codingCli) : null,
      ]);
      return {
        available,
        command: product.available ? product.command : null,
        signIn: analysisSignIn,
        coding: { cli: codingCli, installed: codingInstalled, signIn: codingSignIn },
      };
    }),
  );
  ipcMain.handle(
    CHANNELS.agentRuntimes,
    wrap(async (): Promise<ipc.AgentRuntimeStatus[]> => {
      const settings = getPreferences().agents;
      const { path: envPath } = await ctx.commandPath();
      const probes = new Map<string, Promise<CliProbeResult>>();
      return Promise.all(
        AGENT_IDS.map(async (agent) => {
          const config = { ...settings[agent] };
          if (agent === 'coding-agent') {
            const status = await runtime.probeCoding(config);
            return { agent, config, command: config.cli, available: status.available, version: status.version, reason: status.reason };
          }
          const key = JSON.stringify(config);
          let probing = probes.get(key);
          if (!probing) {
            probing = probeAgent(config, envPath);
            probes.set(key, probing);
          }
          return { agent, config, ...(await probing) };
        }),
      );
    }),
  );

  // Opening settings reads local CLI config only. Refresh invalidates this
  // metadata cache; it never runs inference, auth helpers or remote catalogs.
  const modelCatalogs = new Map<string, Promise<ipc.CliModelCatalog>>();
  ipcMain.handle(
    CHANNELS.agentModels,
    wrap(async (_event, request): Promise<ipc.CliModelCatalog> => {
      if (!request || typeof request !== 'object' || Array.isArray(request)) failWith('Model request must be an object', 'invalid_argument');
      const raw = request as Record<string, unknown>;
      if (!CLI_IDS.includes(raw.cli as ipc.CliId)) failWith('Unknown CLI', 'invalid_argument', 'cli');
      if (raw.scope !== 'analysis' && raw.scope !== 'coding') failWith('Unknown model scope', 'invalid_argument', 'scope');
      if (raw.refresh !== undefined && typeof raw.refresh !== 'boolean') failWith('refresh must be boolean', 'invalid_argument', 'refresh');
      const cli = raw.cli as ipc.CliId;
      const scope = raw.scope as ipc.CliModelScope;
      // Which account's config holds the coding models depends on the isolation mode.
      const separateUser = scope === 'coding' && !runtime.sandboxed();
      const key = `${scope}:${cli}:${separateUser ? 'separate-user' : 'own'}`;
      if (raw.refresh === true) modelCatalogs.delete(key);
      let reading = modelCatalogs.get(key);
      if (!reading) {
        reading = ctx.modelCatalog(cli, scope, { separateUser });
        modelCatalogs.set(key, reading);
      }
      return reading;
    }),
  );
};
