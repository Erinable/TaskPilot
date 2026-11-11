// Environment Steward channels: a setup plan for the open repository, its
// steps run one by one on the user's click, and its scripts copied into the
// checks config. The repository's languages pick the setup adapter; this
// file only passes it on.
import { failWith, requireString } from '../infrastructure/coded_error.ts';
import { logger } from '../infrastructure/logger.ts';
import { AgentRunError } from '../runtimes/claude_cli.ts';
import * as workspace from '../repository/workspace.ts';
import { formatCommandLine } from '../checking/command_line.ts';
import * as verification from '../checking/verification.ts';
import * as presets from '../checking/presets/index.ts';
import { createEnvironmentConfigurationService, environmentRevision } from '../checking/environment_configuration_service.ts';
import { buildProfile } from '../repository/project_profile.ts';
import { planEnvironment } from '../agents/pipeline.ts';
import { registerContract, toFailure } from './handler.ts';
import { envContract } from '../../shared/ipc/environment.ts';
import type * as envelopeTypes from '../../shared/ipc/envelope.ts';
import type * as envTypes from '../../shared/ipc/environment.ts';
import type { EnvFailure } from '../agents/env_steward.ts';
import type { AppContext } from '../app/app_context.ts';
import type { SetupAdapter } from '../checking/setup_adapter.ts';
import type { IpcMainLike } from './handler.ts';
import type { RunInfo } from '../app/background_runs.ts';

type EnvSession = {
  root: string | null;
  revision: string | null;
  status: envTypes.EnvStatus;
  // The adapter the plan was made with; its facts are of its own shape.
  setup: SetupAdapter | null;
  facts: unknown;
  blockers: envTypes.EnvBlocker[];
  plan: Awaited<ReturnType<typeof planEnvironment>>['plan'];
  error: envelopeTypes.IpcFailure | null;
  costUsd: number;
  allowScripts: boolean;
  results: Partial<Record<envTypes.EnvStepId, envTypes.EnvStepResult>>;
  running: envTypes.EnvStepId | null;
  // The running step's output so far (its tail) and when it started.
  live: { output: string; startedAt: string } | null;
  installPackageId: string | null;
  installOnly: boolean;
};

const ENV_OUTPUT_CHARS = 4000;

export const register = (ipcMain: IpcMainLike, ctx: AppContext) => {
  const { getConfig, backgroundRuns } = ctx;
  const configuration = createEnvironmentConfigurationService(ctx);

  // Analysis plans live only in memory. A persisted setup_required halt can
  // recover a fixed install without restoring model-selected scripts.
  const emptySession = (): EnvSession => ({
    root: null,
    revision: null,
    status: 'idle',
    setup: null,
    facts: null,
    blockers: [],
    plan: null,
    error: null,
    costUsd: 0,
    allowScripts: false,
    results: {},
    running: null,
    live: null,
    installPackageId: null,
    installOnly: false,
  });
  let env = emptySession();
  let repositoryGeneration = 0;
  // The steward's plan described the previous repository's toolchain.
  ctx.onRepositoryOpened(() => {
    repositoryGeneration += 1;
    env = emptySession();
  });

  let restoring: { session: EnvSession; work: Promise<void> } | null = null;
  const restoreInstall = async () => {
    const session = env;
    const packageId = configuration.waitingForInstall();
    if (!packageId) {
      if (session.installOnly && !session.running) env = emptySession();
      return;
    }
    if (session.status === 'planning' || session.running || session.installPackageId === packageId) return;
    const work =
      restoring?.session === session
        ? restoring.work
        : configuration.restoreInstall(packageId).then((restored) => {
            if (env !== session || getConfig().root !== restored.root || configuration.waitingForInstall() !== packageId) return;
            env = { ...emptySession(), ...restored, status: 'ready', installPackageId: packageId, installOnly: true };
          });
    restoring = { session, work };
    try {
      await work;
    } catch (error) {
      if (env === session) throw error;
    } finally {
      if (restoring?.work === work) restoring = null;
    }
  };

  // A plan only exists alongside the facts it was made from.
  const effectivePlan = () =>
    env.plan && env.setup && !env.installOnly && configuration.waitingForInstall()
      ? { ...env.plan, install: env.setup.configurationInstallMode, installReason: '配置工作包已更新依赖，需要在本机重新安装；安装脚本仍由下面的开关控制。' }
      : env.plan;
  const envSteps = () => {
    const plan = effectivePlan();
    return plan && env.setup
      ? env.setup
          .buildSteps(plan, env.facts, { allowScripts: env.installOnly ? false : env.allowScripts })
          .filter((step) => !env.installOnly || step.id === 'install')
      : [];
  };

  const envView = async (): Promise<envTypes.EnvState> => {
    await restoreInstall();
    const session = env;
    const currentRoot = getConfig().root;
    const revision = currentRoot && session.root === currentRoot && session.revision ? await environmentRevision(currentRoot) : null;
    const configurationPackage = await configuration.current();
    if (env !== session || getConfig().root !== currentRoot) return envView();
    return {
      root: env.root,
      status: env.status,
      stale: Boolean(env.root && (env.root !== currentRoot || (env.revision && revision !== env.revision))),
      facts: env.setup && env.facts ? env.setup.view(env.facts) : null,
      blockers: env.blockers,
      plan: effectivePlan(),
      configurationPackage,
      error: env.error,
      costUsd: env.costUsd,
      allowScripts: env.allowScripts,
      running: env.running,
      live: env.live,
      steps: envSteps().map((step) => ({
        id: step.id,
        kind: step.kind,
        script: step.script,
        packages: step.packages,
        replacesInstall: step.replacesInstall,
        line: formatCommandLine(step),
        result: env.results[step.id] ?? null,
      })),
      stepKinds: env.installOnly ? [] : [...(env.setup?.stepKinds ?? [])],
      configured: Object.fromEntries(
        (env.setup?.stepKinds ?? []).map((kind) => [kind, (getConfig().steps[kind]?.commands ?? []).map(formatCommandLine).join(' && ')]),
      ),
    };
  };

  const restoreForAction = async () => {
    const generation = repositoryGeneration;
    const root = getConfig().root;
    await restoreInstall();
    if (generation !== repositoryGeneration || root !== getConfig().root) failWith('The repository changed while preparing setup', 'env_stale');
  };

  // A plan only exists alongside the adapter that made it.
  const requireEnvPlan = async () => {
    await restoreForAction();
    if (env.status !== 'ready' || !env.plan || !env.setup) return failWith('No environment plan is ready', 'env_no_plan');
    const session = env;
    if (!session.root || session.root !== getConfig().root || (await environmentRevision(session.root)) !== session.revision || env !== session)
      failWith('The repository changed since this plan was made', 'env_stale');
    if (env.running) failWith('A setup step is already running', 'env_busy');
    return { plan: env.plan, setup: env.setup };
  };

  // Re-planning after a failure hands the steward that step's output.
  const failedStep = (): EnvFailure | null => {
    const failed = envSteps().find((step) => env.results[step.id] && !env.results[step.id]?.ok);
    const result = failed && env.results[failed.id];
    if (!failed || !result) return null;
    return { step: failed.id, command: formatCommandLine(failed), exitCode: result.exitCode, timedOut: result.timedOut, output: result.output };
  };

  registerContract(ipcMain, envContract, {
    get: () => envView(),

    plan: async (options): Promise<envTypes.EnvState> => {
      const root = ctx.requireRoot();
      const generation = repositoryGeneration;
      const stewardRunner = ctx.runnerFor('env-steward');
      if (env.status === 'planning' || env.running) failWith('The Environment Steward is busy', 'env_busy');
      const withFailure = (options as { withFailure?: unknown } | null | undefined)?.withFailure === true && env.root === root;
      const failure = withFailure ? failedStep() : null;
      const keepResults = failure !== null;
      // Resolved fresh, not from the cached profile: a manifest committed since
      // still counts.
      const resolution = await ctx.resolveSteps();
      const setup = presets.setupOf(buildProfile(resolution).languages.map((language) => language.id));
      const revision = await environmentRevision(root);
      if (ctx.requireRoot() !== root || repositoryGeneration !== generation) failWith('The workspace changed while preparing the plan', 'env_stale');
      env = {
        root,
        revision,
        status: 'planning',
        setup,
        facts: null,
        blockers: [],
        plan: null,
        error: null,
        costUsd: 0,
        allowScripts: keepResults ? env.allowScripts : false,
        results: keepResults ? env.results : {},
        running: null,
        live: null,
        installPackageId: configuration.waitingForInstall(),
        installOnly: false,
      };
      ctx.changed('environment');
      const session = env;
      const info: RunInfo = { kind: 'environment', key: '', busy: 'environment', agent: () => 'env-steward', label: () => '环境初始化' };
      void backgroundRuns.run(info, async (controller) => {
        try {
          const { path: envPath } = await ctx.commandPath();
          const outcome = resolution.blank
            ? { facts: null, blockers: ['no_skeleton' as const], plan: null, costUsd: 0 }
            : await planEnvironment({ root, runAgent: stewardRunner, envPath, signal: controller.signal, failure, setup });
          Object.assign(session, { status: 'ready', facts: outcome.facts, blockers: outcome.blockers, plan: outcome.plan, costUsd: outcome.costUsd });
          ctx.changed('environment');
          // Results only carry over for steps the new plan still runs unchanged.
          const lines = new Map(envSteps().map((step) => [step.id, formatCommandLine(step)]));
          for (const id of Object.keys(session.results) as envTypes.EnvStepId[]) {
            if (session.results[id]?.line !== lines.get(id)) delete session.results[id];
          }
        } catch (error) {
          const failure = toFailure(error).error;
          // Nonzero CLI exits can put the useful stderr on detail. It is
          // already redacted at the runtime boundary.
          if (error instanceof AgentRunError && error.detail?.trim() && !failure.message.includes(error.detail.trim()))
            failure.message += `\n${error.detail.trim()}`;
          if (failure.code !== 'agent_cancelled') logger.error('[environment] analysis failed', failure);
          Object.assign(session, { status: 'failed', error: failure });
          ctx.changed('environment');
        }
      });
      return envView();
    },

    setAllowScripts: async (allow): Promise<envTypes.EnvState> => {
      await restoreForAction();
      if (env.running) failWith('A setup step is already running', 'env_busy');
      if (env.installOnly && allow === true) failWith('Recovered installation does not allow lifecycle scripts; analyze explicitly first', 'env_blocked');
      env.allowScripts = allow === true;
      delete env.results.install;
      ctx.changed('environment');
      return envView();
    },

    // The click is the user's confirmation; the command itself is rebuilt here
    // from the stored plan, never taken from the renderer.

    runStep: async (stepId): Promise<envTypes.EnvState> => {
      requireString(stepId, 'stepId');
      const { setup } = await requireEnvPlan();
      const step = envSteps().find((candidate) => candidate.id === stepId);
      if (!step) return failWith(`Unknown setup step: ${stepId}`, 'invalid_argument');
      const blocking = setup.blocking(env.blockers, step.kind);
      if (blocking.length) failWith(`Setup is blocked: ${blocking.join(', ')}`, 'env_blocked');

      const session = env;
      const line = formatCommandLine(step);
      await backgroundRuns.run({ kind: 'environment', key: '', busy: 'environment', label: () => '环境初始化' }, async (controller) => {
        session.running = step.id;
        session.live = { output: '', startedAt: new Date().toISOString() };
        ctx.changed('environment');
        try {
          const result = await verification.run({ root: session.root, commands: { [step.kind]: { command: step.command, args: step.args } } }, step.kind, {
            signal: controller.signal,
            envPath: (await ctx.commandPath()).path,
            timeoutMs: 15 * 60 * 1000,
            onOutput: (chunk) => {
              if (session.live) session.live.output = (session.live.output + chunk).slice(-ENV_OUTPUT_CHARS);
              ctx.changed('environment');
            },
          });
          session.results[step.id] = {
            line,
            ok: result.exitCode === 0 && !result.timedOut,
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            durationMs: result.durationMs,
            summary: step.kind === 'install' || step.kind === 'rebuild' ? null : result.summary,
            output: result.output.slice(-ENV_OUTPUT_CHARS),
            at: new Date().toISOString(),
          };
          ctx.changed('environment');
        } catch (error) {
          if (controller.signal.aborted) failWith('Setup step was cancelled', 'agent_cancelled');
          throw error;
        } finally {
          session.running = null;
          session.live = null;
          ctx.changed('environment');
        }
      });
      return envView();
    },

    // Copies the plan's verification scripts into this machine's steps, for
    // the kinds the user ticked. Lines are rebuilt here, as in envRunStep.

    apply: async (kinds): Promise<envTypes.EnvApplyResult> => {
      const { plan, setup } = await requireEnvPlan();
      if (!Array.isArray(kinds) || kinds.some((kind) => !setup.stepKinds.includes(kind))) {
        failWith(`kinds must be a list of ${setup.stepKinds.join(', ')}`, 'invalid_argument');
      }
      const config = getConfig();
      // workspace.save() normalizes the steps, filling in what is left unset.
      const steps: Record<string, unknown> = { ...config.steps };
      for (const kind of new Set(kinds as envTypes.ScriptKind[])) {
        const name = plan.scripts[kind];
        if (!name) failWith(`The plan has no ${kind} script`, 'invalid_argument');
        // A new command keeps the step's stage and blocking choice; its parser
        // resets, since the old one described a different command.
        const kept = config.steps[kind];
        steps[kind] = { commands: [setup.commandFor(kind, name)], stage: kept?.stage, blocking: kept?.blocking };
      }
      ctx.setConfig(await ctx.repositories.saveConfig(workspace.normalize({ ...config, version: workspace.CONFIG_VERSION, steps })));
      ctx.changed('workspace', 'environment');
      return envView();
    },

    createConfiguration: async () => {
      const { plan } = await requireEnvPlan();
      if (!plan.configuration || !env.revision) return failWith('This plan has no infrastructure work to publish', 'invalid_state');
      return configuration.create(plan.configuration, env.revision);
    },

    cancel: (): boolean => {
      const controller = backgroundRuns.get('environment', '');
      if (!controller) return false;
      controller.abort();
      return true;
    },
  });
};
