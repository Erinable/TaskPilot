// Workspace channels: the open repository's check steps (this machine's
// settings, taskpilot.toml and its preset), its git state and diffs, manual
// step runs and opening files in the editor.
import { codedError, failWith, requireString } from '../infrastructure/coded_error.ts';
import * as tasks from '../work_packages/tasks.ts';
import * as git from '../repository/git.ts';
import * as workspace from '../repository/workspace.ts';
import * as verification from '../checking/verification.ts';
import * as evidence from '../checking/evidence.ts';
import * as stepForm from '../checking/step_form.ts';
import * as projectConfig from '../repository/project_config.ts';
import * as presets from '../checking/presets/index.ts';
import * as courses from '../courses/courses.ts';
import { checkLine } from '../checking/submit_checks.ts';
import { openWorkspaceFile } from '../repository/open_file.ts';
import { toolVersion } from '../infrastructure/tool_version.ts';
import { registerContract } from './handler.ts';
import { workspaceContract, diffContract, verifyContract } from '../../shared/ipc/workspace.ts';
import { STEP_KINDS, isStepId } from '../../shared/check_steps.ts';
import type * as workspaceTypes from '../../shared/ipc/workspace.ts';
import type { AppContext } from '../app/app_context.ts';
import type { IpcMainLike } from './handler.ts';

export const register = (ipcMain: IpcMainLike, ctx: AppContext) => {
  const { getConfig, setConfig, requireRoot, requireTask, requireBaseline, shell } = ctx;

  // Every step, merged, as the settings page shows it. The fixed steps are
  // always listed, so one nobody configured reads as skipped.
  const viewOf = async (config: workspace.WorkspaceConfig): Promise<workspaceTypes.WorkspaceView> => {
    const [resolution, { pack: _pack, ...course }] = await Promise.all([ctx.resolveSteps(config, { always: STEP_KINDS }), ctx.course(config)]);
    return {
      root: config.root,
      steps: stepForm.stepViews(config, resolution),
      project: resolution.project,
      course,
      detected: resolution.detected,
      presets: presets.PRESETS.map((preset) => ({ id: preset.id, label: preset.label })),
    };
  };

  // Parses and checks a settings form. The root is the open repository's,
  // whatever the form says: repositories are added and moved through
  // repositories:add and repositories:relocate.
  const validateForm = async (form: unknown) => {
    const config = stepForm.fromForm(form, getConfig());
    config.root = getConfig().root;
    const info: { repo: workspaceTypes.RepoInfo | null } = { repo: null };
    if (!config.root) return { config, info };
    const checked = await ctx.validateRoot(config.root);
    config.root = checked.root;
    info.repo = checked.repo;
    return { config, info };
  };

  // Resolves a renderer-supplied path, refusing anything outside the root.
  const safePath = (root: string, candidate: unknown) => {
    const checked = requireString(candidate, 'path');
    if (!workspace.isInside(root, checked)) throw codedError(`Path is outside the workspace: ${checked}`, 'path_outside_workspace');
    return checked;
  };

  registerContract(ipcMain, workspaceContract, {
    get: (): Promise<workspaceTypes.WorkspaceView> => viewOf(getConfig()),

    // Validates everything before writing, so a bad path or command is never
    // persisted and reloaded on the next launch.

    set: async (form): Promise<workspaceTypes.WorkspaceView> => {
      const { config } = await validateForm(form);
      const saved = await ctx.repositories.saveConfig(config);
      setConfig(saved);
      ctx.changed('workspace');
      return viewOf(saved);
    },

    // Same validation as saving, plus a PATH lookup for each step's first
    // command and the preset's tools, without writing anything. Lets the
    // settings page warn before the user commits; a missing tool is only
    // reported with how to install it, never installed.

    check: async (form): Promise<workspaceTypes.WorkspaceCheck> => {
      const { config, info } = await validateForm(form);
      const { path: envPath } = await ctx.commandPath();
      const resolution = await ctx.resolveSteps(config, { always: STEP_KINDS });
      const steps: workspaceTypes.WorkspaceCheck['steps'] = {};
      for (const entry of resolution.steps) {
        const first = entry.step?.commands[0];
        // Resolve against the PATH and directory commands will actually run with.
        const cwd = config.root && entry.step ? `${config.root}/${entry.step.cwd}` : config.root;
        steps[entry.id] = first
          ? { configured: true, resolved: await workspace.resolveExecutable(first.command, { cwd, envPath }) }
          : { configured: false, resolved: null };
      }
      const preset = presets.presetById(resolution.project.status === 'ok' ? resolution.project.preset : null);
      const tools = await Promise.all(
        (preset?.tools ?? []).map(async (tool) => ({
          command: tool.command,
          version: await toolVersion(tool.command, tool.versionArgs, envPath),
          install: tool.install,
        })),
      );
      return { root: config.root, repo: info.repo, steps, tools };
    },

    // Writes taskpilot.toml naming the preset the user picked. Only on their
    // click, and never over an existing file.

    createProject: async (rawPreset): Promise<workspaceTypes.WorkspaceView> => {
      const preset = requireString(rawPreset, 'preset');
      if (preset !== 'none' && !presets.PRESET_IDS.includes(preset)) failWith(`Unknown preset: ${preset}`, 'invalid_argument', 'preset');
      const root = requireRoot();
      // The commented examples are the preset's own suggestions, so a Rust or
      // Python repository is not shown npm commands.
      const source = presets.presetById(preset);
      const suggestions = source ? source.suggestions(await source.facts(root, { envPath: (await ctx.commandPath()).path })) : {};
      await projectConfig.createProjectFile(root, preset, { lint: suggestions.lint?.[0] ?? null, custom: suggestions.typecheck?.[0] ?? null });
      ctx.changed('workspace', 'environment');
      return viewOf(getConfig());
    },

    // Confirms the pending course pack (the repository's or an imported one)
    // on this machine, after the user read it. `contentHash` is the one they were shown: a pack that changed
    // in between is refused, so nobody confirms content they did not see.

    confirmCourse: async (rawId, rawHash): Promise<workspaceTypes.WorkspaceView> => {
      const id = requireString(rawId, 'id');
      const contentHash = requireString(rawHash, 'contentHash');
      requireRoot();
      const { state } = await ctx.course();
      if (state.status !== 'pending' || state.ref.id !== id) failWith(`Course pack ${id} is not waiting for confirmation`, 'course_not_pending', 'course');
      if (state.ref.contentHash !== contentHash) failWith(`Course pack ${id} changed since it was shown`, 'course_changed', 'course');
      await courses.confirm(ctx.coursePlaces(), state.pack, state.ref);
      ctx.changed('courses', 'workspace');
      return viewOf(getConfig());
    },

    pickRoot: async (): Promise<string | null> => {
      if (!shell.pickDirectory) throw codedError('Directory picker is unavailable', 'unsupported');
      return shell.pickDirectory(getConfig().root);
    },

    info: async (): Promise<workspaceTypes.WorkspaceInfo> => {
      const config = getConfig();
      if (!config.root) return { configured: false };
      return { configured: true, root: config.root, ...(await git.describe(config.root)) };
    },

    // Opens a workspace file in the developer's editor, at a line when given.
    // The path may come from a QA issue (model text); open_file.ts confines it
    // to the workspace after symlinks.

    openFile: async (filePath, line): Promise<workspaceTypes.OpenedWith> => {
      if (!shell.revealFile) return failWith('Opening files is unavailable', 'unsupported');
      const root = requireRoot();
      const { path: envPath } = await ctx.commandPath();
      // Anything but a number or null is passed as NaN, which open_file.ts rejects as invalid_line.
      const lineNumber = line === null || line === undefined ? null : typeof line === 'number' ? line : Number.NaN;
      return openWorkspaceFile(root, requireString(filePath, 'path'), lineNumber, { envPath, launch: shell.launchEditor, reveal: shell.revealFile });
    },
  });
  registerContract(ipcMain, diffContract, {
    stat: async (rawId): Promise<workspaceTypes.DiffStat> => {
      const root = requireRoot();
      const id = requireString(rawId, 'id');
      const task = requireTask(id);
      const changes = await git.changesSince(root, requireBaseline(id));
      return {
        changes,
        scope: tasks.checkFileScope(
          task,
          changes.map((c) => c.path),
        ),
      };
    },

    file: async (id, filePath): Promise<workspaceTypes.DiffFile> => {
      const root = requireRoot();
      return git.diffFile(root, requireBaseline(requireString(id, 'id')), safePath(root, filePath));
    },
  });
  registerContract(ipcMain, verifyContract, {
    run: async (kind, taskId): Promise<workspaceTypes.VerifyRun> => {
      if (!isStepId(kind)) throw codedError(`Unknown verification kind: ${kind}`, 'invalid_argument');
      const config = getConfig();
      const step = (await ctx.runnableSteps(config)).find((candidate) => candidate.id === kind);
      if (!step) throw new verification.VerificationError(`No ${kind} command is configured`, 'not_configured');
      // runStep() echoes the step id it ran.
      const result = { ...(await verification.runStep(config.root, step, { envPath: (await ctx.commandPath()).path })), kind };
      if (!taskId) return result;
      const task = requireTask(requireString(taskId, 'taskId'));
      // The same comparison a review makes, so a manual run reads the same way.
      const check = { kind, stage: step.stage, blocking: step.blocking, line: checkLine(step) };
      const baselines = ctx.store.get(task.id).baselineChecks?.checks ?? {};
      const item = evidence.evaluate(check, result, evidence.usableBaseline(baselines[kind], check.line));
      return {
        ...result,
        evidence: item,
        acceptance: evidence.criteriaStatus(task.acceptance ?? [], { [kind]: result }, [item], baselines),
      };
    },
  });
};
