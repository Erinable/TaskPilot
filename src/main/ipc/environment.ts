// Environment Steward channels: a setup plan for the open repository, its
// steps run one by one on the user's click, and its scripts copied into the
// checks config. The repository's languages pick the setup adapter; this
// file only passes it on.
import { failWith, requireString } from '../infrastructure/coded_error.ts';
import * as workspace from '../repository/workspace.ts';
import { formatCommandLine } from '../checking/command_line.ts';
import * as verification from '../checking/verification.ts';
import * as presets from '../checking/presets/index.ts';
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

type EnvSession = {
  root: string | null;
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
};

const ENV_OUTPUT_CHARS = 4000;

export const register = (ipcMain: IpcMainLike, ctx: AppContext) => {
  const { getConfig, backgroundRuns } = ctx;

  // One session per app run, in memory only: the plan is cheap to redo and
  // must not outlive the toolchain it was made for.
  let env: EnvSession = {
    root: null,
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
  };
  // The steward's plan described the previous repository's toolchain.
  ctx.onRepositoryOpened(() => {
    env = {
      ...env,
      root: null,
      status: 'idle',
      setup: null,
      facts: null,
      blockers: [],
      plan: null,
      error: null,
      costUsd: 0,
      results: {},
      running: null,
      live: null,
    };
  });

  // A plan only exists alongside the facts it was made from.
  const envSteps = () => (env.plan && env.setup ? env.setup.buildSteps(env.plan, env.facts, { allowScripts: env.allowScripts }) : []);

  const envView = (): envTypes.EnvState => ({
    root: env.root,
    status: env.status,
    stale: Boolean(env.root && env.root !== getConfig().root),
    facts: env.setup && env.facts ? env.setup.view(env.facts) : null,
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
      script: step.script,
      packages: step.packages,
      replacesInstall: step.replacesInstall,
      line: formatCommandLine(step),
      result: env.results[step.id] ?? null,
    })),
    stepKinds: [...(env.setup?.stepKinds ?? [])],
    configured: Object.fromEntries(
      (env.setup?.stepKinds ?? []).map((kind) => [kind, (getConfig().steps[kind]?.commands ?? []).map(formatCommandLine).join(' && ')]),
    ),
  });

  // A plan only exists alongside the adapter that made it.
  const requireEnvPlan = () => {
    if (env.status !== 'ready' || !env.plan || !env.setup) return failWith('No environment plan is ready', 'env_no_plan');
    if (env.root !== getConfig().root) failWith('The workspace changed since this plan was made', 'env_stale');
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
    get: (): envTypes.EnvState => envView(),

    plan: async (options): Promise<envTypes.EnvState> => {
      const root = ctx.requireRoot();
      const stewardRunner = ctx.runnerFor('env-steward');
      if (env.status === 'planning' || env.running) failWith('The Environment Steward is busy', 'env_busy');
      const withFailure = (options as { withFailure?: unknown } | null | undefined)?.withFailure === true && env.root === root;
      const failure = withFailure ? failedStep() : null;
      const keepResults = failure !== null;
      // Resolved fresh, not from the cached profile: a manifest committed since
      // still counts.
      const setup = presets.setupOf(buildProfile(await ctx.resolveSteps()).languages.map((language) => language.id));
      env = {
        root,
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
      };
      ctx.changed('environment');
      const session = env;
      const controller = backgroundRuns.start({ kind: 'environment', key: '', busy: 'environment', agent: () => 'env-steward', label: () => '环境初始化' });
      const { path: envPath } = await ctx.commandPath();
      backgroundRuns.track(
        (async () => {
          try {
            const outcome = await planEnvironment({ root, runAgent: stewardRunner, envPath, signal: controller.signal, failure, setup });
            Object.assign(session, { status: 'ready', facts: outcome.facts, blockers: outcome.blockers, plan: outcome.plan, costUsd: outcome.costUsd });
            ctx.changed('environment');
            // Results only carry over for steps the new plan still runs unchanged.
            const lines = new Map(envSteps().map((step) => [step.id, formatCommandLine(step)]));
            for (const id of Object.keys(session.results) as envTypes.EnvStepId[]) {
              if (session.results[id]?.line !== lines.get(id)) delete session.results[id];
            }
          } catch (error) {
            Object.assign(session, { status: 'failed', error: toFailure(error).error });
            ctx.changed('environment');
          } finally {
            backgroundRuns.finish('environment', '', controller);
          }
        })(),
      );
      return envView();
    },

    setAllowScripts: (allow): envTypes.EnvState => {
      if (env.running) failWith('A setup step is already running', 'env_busy');
      env.allowScripts = allow === true;
      delete env.results.install;
      ctx.changed('environment');
      return envView();
    },

    // The click is the user's confirmation; the command itself is rebuilt here
    // from the stored plan, never taken from the renderer.

    runStep: async (stepId): Promise<envTypes.EnvState> => {
      requireString(stepId, 'stepId');
      const { setup } = requireEnvPlan();
      const step = envSteps().find((candidate) => candidate.id === stepId);
      if (!step) return failWith(`Unknown setup step: ${stepId}`, 'invalid_argument');
      const blocking = setup.blocking(env.blockers, step.kind);
      if (blocking.length) failWith(`Setup is blocked: ${blocking.join(', ')}`, 'env_blocked');

      const session = env;
      const controller = backgroundRuns.start({ kind: 'environment', key: '', busy: 'environment', label: () => '环境初始化' });
      session.running = step.id;
      session.live = { output: '', startedAt: new Date().toISOString() };
      ctx.changed('environment');
      const line = formatCommandLine(step);
      const run = (async () => {
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
        } finally {
          session.running = null;
          session.live = null;
          ctx.changed('environment');
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
    },

    // Copies the plan's verification scripts into this machine's steps, for
    // the kinds the user ticked. Lines are rebuilt here, as in envRunStep.

    apply: async (kinds): Promise<envTypes.EnvApplyResult> => {
      const { plan, setup } = requireEnvPlan();
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

    cancel: (): boolean => {
      const controller = backgroundRuns.get('environment', '');
      if (!controller) return false;
      controller.abort();
      return true;
    },
  });
};
