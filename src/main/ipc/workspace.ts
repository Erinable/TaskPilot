// Workspace channels: the open repository's checks config, its git state and
// diffs, manual check runs and opening files in the editor.
import { codedError, failWith, requireString } from '../coded_error.ts';
import * as tasks from '../tasks.ts';
import * as git from '../git.ts';
import * as workspace from '../workspace.ts';
import * as verification from '../verification.ts';
import * as evidence from '../evidence.ts';
import { checkLine } from '../submit_checks.ts';
import { openWorkspaceFile } from '../open_file.ts';
import { wrap } from './handler.ts';
import { CHANNELS } from '../../shared/ipc_channels.ts';
import type * as workspaceTypes from '../../shared/ipc/workspace.ts';
import type { AppContext } from '../app_context.ts';
import type { IpcMainLike } from './handler.ts';

// Config plus the command lines and check options the settings form edits.
export const toFormView = (config: workspace.WorkspaceConfig): workspaceTypes.WorkspaceView => {
  const form = workspace.toForm(config);
  return { root: config.root, commands: config.commands, checks: config.checks, lines: form.commands, options: form.options };
};

const isCommandKind = (value: unknown): value is workspace.CheckKind => workspace.COMMAND_KINDS.includes(value as workspace.CheckKind);

export const register = (ipcMain: IpcMainLike, ctx: AppContext) => {
  const { getConfig, setConfig, requireRoot, requireTask, requireBaseline, shell } = ctx;

  // Parses and checks a settings form. The root is the open repository's,
  // whatever the form says: repositories are added and moved through
  // repositories:add and repositories:relocate.
  const validateForm = async (form: unknown) => {
    const config = workspace.fromForm(form as workspace.WorkspaceFormInput, getConfig());
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

  ipcMain.handle(
    CHANNELS.workspaceGet,
    wrap((): workspaceTypes.WorkspaceView => toFormView(getConfig())),
  );

  // Validates everything before writing, so a bad path or command is never
  // persisted and reloaded on the next launch.
  ipcMain.handle(
    CHANNELS.workspaceSet,
    wrap(async (_event, form): Promise<workspaceTypes.WorkspaceView> => {
      const { config } = await validateForm(form);
      const saved = await ctx.repositories.saveConfig(config);
      setConfig(saved);
      return toFormView(saved);
    }),
  );

  // Same validation as saving, plus a PATH lookup for each command, without
  // writing anything. Lets the settings page warn before the user commits.
  ipcMain.handle(
    CHANNELS.workspaceCheck,
    wrap(async (_event, form): Promise<workspaceTypes.WorkspaceCheck> => {
      const { config, info } = await validateForm(form);
      const { path: envPath } = await ctx.commandPath();
      const commands = {} as workspaceTypes.WorkspaceCheck['commands'];
      for (const kind of workspace.COMMAND_KINDS) {
        const entry = config.commands[kind];
        commands[kind] = entry
          ? // Resolve against the PATH commands will actually run with.
            { configured: true, resolved: await workspace.resolveExecutable(entry.command, { cwd: config.root, envPath }) }
          : { configured: false, resolved: null };
      }
      return { root: config.root, repo: info.repo, commands };
    }),
  );

  ipcMain.handle(
    CHANNELS.workspacePickRoot,
    wrap(async (): Promise<string | null> => {
      if (!shell.pickDirectory) throw codedError('Directory picker is unavailable', 'unsupported');
      return shell.pickDirectory(getConfig().root);
    }),
  );

  ipcMain.handle(
    CHANNELS.workspaceInfo,
    wrap(async (): Promise<workspaceTypes.WorkspaceInfo> => {
      const config = getConfig();
      if (!config.root) return { configured: false };
      return { configured: true, root: config.root, ...(await git.describe(config.root)) };
    }),
  );

  // Opens a workspace file in the developer's editor, at a line when given.
  // The path may come from a QA issue (model text); open_file.ts confines it
  // to the workspace after symlinks.
  ipcMain.handle(
    CHANNELS.workspaceOpenFile,
    wrap(async (_event, filePath, line): Promise<workspaceTypes.OpenedWith> => {
      if (!shell.revealFile) return failWith('Opening files is unavailable', 'unsupported');
      const root = requireRoot();
      const { path: envPath } = await ctx.commandPath();
      // Anything but a number or null is passed as NaN, which open_file.ts rejects as invalid_line.
      const lineNumber = line === null || line === undefined ? null : typeof line === 'number' ? line : Number.NaN;
      return openWorkspaceFile(root, requireString(filePath, 'path'), lineNumber, { envPath, launch: shell.launchEditor, reveal: shell.revealFile });
    }),
  );

  ipcMain.handle(
    CHANNELS.diffStat,
    wrap(async (_event, rawId): Promise<workspaceTypes.DiffStat> => {
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
    }),
  );

  ipcMain.handle(
    CHANNELS.diffFile,
    wrap(async (_event, id, filePath): Promise<workspaceTypes.DiffFile> => {
      const root = requireRoot();
      return git.diffFile(root, requireBaseline(requireString(id, 'id')), safePath(root, filePath));
    }),
  );

  ipcMain.handle(
    CHANNELS.verifyRun,
    wrap(async (_event, kind, taskId): Promise<workspaceTypes.VerifyRun> => {
      if (!isCommandKind(kind)) throw codedError(`Unknown verification kind: ${kind}`, 'invalid_argument');
      const config = getConfig();
      // runCheck() echoes the kind it ran, which is a CheckKind here.
      const result = { ...(await verification.runCheck(config, kind, { envPath: (await ctx.commandPath()).path })), kind };
      if (!taskId) return result;
      const task = requireTask(requireString(taskId, 'taskId'));
      // runCheck() succeeded, so the check is configured.
      const configured = config.checks[kind] as workspace.Check;
      // The same comparison a review makes, so a manual run reads the same way.
      const check = { kind, stage: configured.stage, blocking: configured.blocking, line: checkLine(configured) };
      const baselines = ctx.store.get(task.id).baselineChecks?.checks ?? {};
      const item = evidence.evaluate(check, result, evidence.usableBaseline(baselines[kind], check.line));
      return {
        ...result,
        evidence: item,
        acceptance: evidence.criteriaStatus(task.acceptance ?? [], { [kind]: result }, [item], baselines),
      };
    }),
  );
};
