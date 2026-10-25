// Environment Steward channels: a setup plan for the open repository, its
// steps run one by one on the user's click, and its scripts copied into the
// checks config.
import { failWith, requireString } from '../coded_error.ts';
import * as workspace from '../workspace.ts';
import * as verification from '../verification.ts';
import * as envSetup from '../env_setup.ts';
import { planEnvironment } from '../agents/pipeline.ts';
import { toFailure, wrap } from './handler.ts';
import { CHANNELS } from '../../shared/ipc_channels.ts';
import type * as ipc from '../../shared/ipc_types.ts';
import type { EnvFailure } from '../agents/env_steward.ts';
import type { AppContext } from '../app_context.ts';
import type { IpcMainLike } from './handler.ts';

type EnvSession = {
  root: string | null;
  status: ipc.EnvStatus;
  facts: Awaited<ReturnType<typeof envSetup.probe>> | null;
  blockers: ReturnType<typeof envSetup.blockers>;
  plan: Awaited<ReturnType<typeof planEnvironment>>['plan'];
  error: ipc.IpcFailure | null;
  costUsd: number;
  allowScripts: boolean;
  results: Partial<Record<ipc.EnvStepId, ipc.EnvStepResult>>;
  running: ipc.EnvStepId | null;
  // The running step's output so far (its tail) and when it started.
  live: { output: string; startedAt: string } | null;
};

const ENV_OUTPUT_CHARS = 4000;

export const register = (ipcMain: IpcMainLike, ctx: AppContext) => {
  const { getConfig, backgroundRuns } = ctx;

  // One session per app run, in memory only: the plan is cheap to redo and
  // must not outlive the toolchain it was made for.
  let env: EnvSession = {
    root: null,
    status: 'idle',
    facts: null,
    blockers: [],
    plan: null,
    error: null,
    costUsd: 0,
    allowScripts: false,
    results: {},
    running: null,
    live: null,
  };
  // The steward's plan described the previous repository's toolchain.
  ctx.onRepositoryOpened(() => {
    env = { ...env, root: null, status: 'idle', facts: null, blockers: [], plan: null, error: null, costUsd: 0, results: {}, running: null, live: null };
  });

  // A plan only exists alongside the facts it was made from.
  const envSteps = () => (env.plan && env.facts ? envSetup.buildSteps(env.plan, env.facts, { allowScripts: env.allowScripts }) : []);

  const envView = (): ipc.EnvState => ({
    root: env.root,
    status: env.status,
    stale: Boolean(env.root && env.root !== getConfig().root),
    facts: env.facts && {
      ...env.facts,
      workflows: env.facts.workflows.map((file) => file.path),
      versionFiles: env.facts.versionFiles,
    },
    blockers: env.blockers,
    plan: env.plan,
    error: env.error,
    costUsd: env.costUsd,
    allowScripts: env.allowScripts,
    running: env.running,
    live: env.live,
    steps: envSteps().map((step) => ({
      id: step.id,
      kind: step.kind,
      script: 'script' in step ? step.script : null,
      packages: 'packages' in step ? step.packages : [],
      replacesInstall: step.kind === 'install' && step.args[0] === 'ci' && Boolean(env.facts?.nodeModules),
      line: workspace.formatCommandLine(step),
      result: env.results[step.id] ?? null,
    })),
    configured: Object.fromEntries(
      workspace.COMMAND_KINDS.map((kind) => [kind, workspace.formatCommandLine(getConfig().commands[kind])]),
    ) as ipc.EnvState['configured'],
  });

  const requireEnvPlan = () => {
    if (env.status !== 'ready' || !env.plan) return failWith('No environment plan is ready', 'env_no_plan');
    if (env.root !== getConfig().root) failWith('The workspace changed since this plan was made', 'env_stale');
    if (env.running) failWith('A setup step is already running', 'env_busy');
    return env.plan;
  };

  // Re-planning after a failure hands the steward that step's output.
  const failedStep = (): EnvFailure | null => {
    const failed = envSteps().find((step) => env.results[step.id] && !env.results[step.id]?.ok);
    const result = failed && env.results[failed.id];
    if (!failed || !result) return null;
    return { step: failed.id, command: workspace.formatCommandLine(failed), exitCode: result.exitCode, timedOut: result.timedOut, output: result.output };
  };

  ipcMain.handle(
    CHANNELS.envGet,
    wrap((): ipc.EnvState => envView()),
  );

  ipcMain.handle(
    CHANNELS.envPlan,
    wrap(async (_event, options): Promise<ipc.EnvState> => {
      const root = ctx.requireRoot();
      const stewardRunner = ctx.runnerFor('env-steward');
      if (env.status === 'planning' || env.running) failWith('The Environment Steward is busy', 'env_busy');
      const withFailure = (options as { withFailure?: unknown } | null | undefined)?.withFailure === true && env.root === root;
      const failure = withFailure ? failedStep() : null;
      const keepResults = failure !== null;
      env = {
        root,
        status: 'planning',
        facts: null,
        blockers: [],
        plan: null,
        error: null,
        costUsd: 0,
        allowScripts: keepResults ? env.allowScripts : false,
        results: keepResults ? env.results : {},
        running: null,
        live: null,
      };
      const session = env;
      const controller = backgroundRuns.start({ kind: 'environment', key: '', busy: 'environment', label: () => '环境初始化' });
      const { path: envPath } = await ctx.commandPath();
      backgroundRuns.track(
        (async () => {
          try {
            const outcome = await planEnvironment({ root, runAgent: stewardRunner, envPath, signal: controller.signal, failure });
            Object.assign(session, { status: 'ready', facts: outcome.facts, blockers: outcome.blockers, plan: outcome.plan, costUsd: outcome.costUsd });
            // Results only carry over for steps the new plan still runs unchanged.
            const lines = new Map(envSteps().map((step) => [step.id, workspace.formatCommandLine(step)]));
            for (const id of Object.keys(session.results) as ipc.EnvStepId[]) {
              if (session.results[id]?.line !== lines.get(id)) delete session.results[id];
            }
          } catch (error) {
            Object.assign(session, { status: 'failed', error: toFailure(error).error });
          } finally {
            backgroundRuns.finish('environment', '', controller);
          }
        })(),
      );
      return envView();
    }),
  );

  ipcMain.handle(
    CHANNELS.envSetAllowScripts,
    wrap((_event, allow): ipc.EnvState => {
      if (env.running) failWith('A setup step is already running', 'env_busy');
      env.allowScripts = allow === true;
      delete env.results.install;
      return envView();
    }),
  );

  // The click is the user's confirmation; the command itself is rebuilt here
  // from the stored plan, never taken from the renderer.
  ipcMain.handle(
    CHANNELS.envRunStep,
    wrap(async (_event, stepId): Promise<ipc.EnvState> => {
      requireString(stepId, 'stepId');
      requireEnvPlan();
      const step = envSteps().find((candidate) => candidate.id === stepId);
      if (!step) return failWith(`Unknown setup step: ${stepId}`, 'invalid_argument');
      const blocking = env.blockers.filter((code) => code !== 'unsupported_manager' || step.kind === 'install');
      if (blocking.length) failWith(`Setup is blocked: ${blocking.join(', ')}`, 'env_blocked');

      const session = env;
      const controller = backgroundRuns.start({ kind: 'environment', key: '', busy: 'environment', label: () => '环境初始化' });
      session.running = step.id;
      session.live = { output: '', startedAt: new Date().toISOString() };
      const line = workspace.formatCommandLine(step);
      const run = (async () => {
        try {
          const result = await verification.run({ root: session.root, commands: { [step.kind]: { command: step.command, args: step.args } } }, step.kind, {
            signal: controller.signal,
            envPath: (await ctx.commandPath()).path,
            timeoutMs: 15 * 60 * 1000,
            onOutput: (chunk) => {
              if (session.live) session.live.output = (session.live.output + chunk).slice(-ENV_OUTPUT_CHARS);
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
        } finally {
          session.running = null;
          session.live = null;
          backgroundRuns.finish('environment', '', controller);
        }
      })();
      backgroundRuns.track(run.catch(() => {}));
      try {
        await run;
      } catch (error) {
        if (controller.signal.aborted) failWith('Setup step was cancelled', 'agent_cancelled');
        throw error;
      }
      return envView();
    }),
  );

  // Copies the plan's verification scripts into workspace.json, for the
  // kinds the user ticked. Lines are rebuilt here, as in envRunStep.
  ipcMain.handle(
    CHANNELS.envApply,
    wrap(async (_event, kinds): Promise<ipc.EnvApplyResult> => {
      const plan = requireEnvPlan();
      if (!Array.isArray(kinds) || kinds.some((kind) => !envSetup.SCRIPT_KINDS.includes(kind))) {
        failWith('kinds must be a list of test, lint or build', 'invalid_argument');
      }
      const config = getConfig();
      // workspace.save() normalizes the checks, filling in what is left unset.
      const checks: Record<string, unknown> = { ...config.checks };
      for (const kind of new Set(kinds as ipc.ScriptKind[])) {
        const name = plan.scripts[kind];
        if (!name) failWith(`The plan has no ${kind} script`, 'invalid_argument');
        // A new command keeps the slot's stage and blocking choice; its report
        // format resets, since the old one described a different command.
        const kept = config.checks[kind];
        checks[kind] = { ...envSetup.scriptCommand(name), stage: kept?.stage, blocking: kept?.blocking };
      }
      ctx.setConfig(await ctx.repositories.saveConfig(workspace.normalize({ ...config, checks })));
      return envView();
    }),
  );

  ipcMain.handle(
    CHANNELS.envCancel,
    wrap((): boolean => {
      const controller = backgroundRuns.get('environment', '');
      if (!controller) return false;
      controller.abort();
      return true;
    }),
  );
};
