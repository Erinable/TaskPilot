import { app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme, shell } from 'electron';
import type { OpenDialogOptions } from 'electron';
import path from 'node:path';

import { registerIpcHandlers } from './ipc.ts';
import { registerContract } from './ipc/handler.ts';
import { createStartupGate } from './app/startup_gate.ts';
import { createQuitHandler } from './app/application_quit.ts';
import type { IpcHandle } from './ipc.ts';
import { WorkPackageStore } from './work_packages/work_package_store.ts';
import { RequirementStore } from './requirements/requirement_store.ts';
import { ReleaseStore } from './release/release_store.ts';
import * as preferences from './app/preferences.ts';
import { createPathResolver } from './infrastructure/shell_env.ts';
import { env } from './infrastructure/env.ts';
import { ActivityLog } from './activity/activity_log.ts';
import { RepositoryRegistry } from './repository/repositories.ts';
import { TutorStore } from './work_packages/tutor_store.ts';
import { NoteStore } from './notes/note_store.ts';
import { MasteryStore } from './courses/mastery_store.ts';
import * as courses from './courses/courses.ts';
import { CHANNELS } from '../shared/ipc_channels.ts';
import { appContract } from '../shared/ipc/app.ts';
import { initializeLogging, flushLogs, logger } from './infrastructure/logger.ts';
import { applyPendingRestore } from './infrastructure/data_backup.ts';
import { restoreAtStartup } from './app/startup_recovery.ts';
import { codedError } from './infrastructure/coded_error.ts';

// Matches --canvas in tokens.css, so the first paint and any area the page
// doesn't cover use the theme's colour rather than a white flash.
const CANVAS = { light: '#f1edfb', dark: '#0d0f16' };
const canvasColor = () => (nativeTheme.shouldUseDarkColors ? CANVAS.dark : CANVAS.light);

type Appearance = { vibrancy: boolean };

// Windows showing native vibrancy; their background stays transparent.
const vibrantWindows = new WeakSet<BrowserWindow>();

// Set once the IPC handlers are registered, so quitting can shut them down.
let ipcHandle: IpcHandle | null = null;
let initialization: Promise<void> | null = null;

// The packaged app is named TaskPilot, development runs as taskpilot; on a
// case-sensitive volume those are two directories. Both use this one.
if (env.dataDir !== null && !path.isAbsolute(env.dataDir)) throw new Error('TASKPILOT_DATA_DIR must be an absolute path');
app.setPath('userData', env.dataDir ?? path.join(app.getPath('appData'), 'taskpilot'));
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
app.on('second-instance', () => {
  const window = BrowserWindow.getAllWindows()[0];
  if (window?.isMinimized()) window.restore();
  window?.focus();
});

// Native vibrancy (macOS only) lets the desktop show through the window. The
// page's own backdrop is made transparent at the same time (see the
// `vibrancy` class in styles.css), otherwise it would cover the effect.
const applyAppearance = (window: BrowserWindow, appearance: Appearance) => {
  if (process.platform !== 'darwin') return;
  if (appearance.vibrancy) {
    window.setVibrancy('under-window');
    window.setBackgroundColor('#00000000');
  } else {
    window.setVibrancy(null);
    window.setBackgroundColor(canvasColor());
  }
};

const createWindow = (appearance: Appearance) => {
  const vibrant = process.platform === 'darwin' && appearance.vibrancy;
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: vibrant ? '#00000000' : canvasColor(),
    ...(vibrant ? { vibrancy: 'under-window' as const, visualEffectState: 'followWindow' as const } : {}),
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 20, y: 20 },
    webPreferences: {
      // The renderer's only source for the business time zone (see preload).
      additionalArguments: [`--taskpilot-time-zone=${env.businessTimeZone}`],
      preload: path.join(import.meta.dirname, '..', 'preload', 'index.cjs'),
      contextIsolation: true,
      sandbox: true,
    },
  });

  // Keep the window background in step with a live light/dark switch.
  const syncBackground = () => {
    if (!window.isDestroyed() && !vibrantWindows.has(window)) window.setBackgroundColor(canvasColor());
  };
  if (vibrant) vibrantWindows.add(window);
  nativeTheme.on('updated', syncBackground);
  window.on('closed', () => nativeTheme.off('updated', syncBackground));

  // Full screen hides the traffic lights, so the top bar can use their space.
  const sendFullScreen = () => window.webContents.send(CHANNELS.appOnFullScreen, window.isFullScreen());
  window.on('enter-full-screen', sendFullScreen);
  window.on('leave-full-screen', sendFullScreen);
  window.webContents.on('did-finish-load', sendFullScreen);
  let recoveryPromptOpen = false;
  window.webContents.on('render-process-gone', (_event, details) => {
    if (quitHandler.isQuitting() || window.isDestroyed() || recoveryPromptOpen || details.reason === 'clean-exit') return;
    logger.error('[window] renderer exited', { reason: details.reason, exitCode: details.exitCode });
    recoveryPromptOpen = true;
    dialog
      .showMessageBox(window, {
        type: 'error',
        title: '界面意外退出',
        message: 'TaskPilot 的界面意外退出。',
        detail: '已保存的数据会保留。重新加载界面后，可以查看任务状态并继续操作。',
        buttons: ['重新加载界面', '关闭窗口'],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (window.isDestroyed()) return;
        if (response === 0) window.webContents.reload();
        else window.close();
      })
      .catch((error) => logger.error('[window] recovery prompt failed', error))
      .finally(() => {
        recoveryPromptOpen = false;
      });
  });

  if (env.rendererUrl) window.loadURL(env.rendererUrl);
  else window.loadFile(path.join(import.meta.dirname, '..', 'renderer', 'index.html'));
  return window;
};

app.whenReady().then(async () => {
  if (!primaryInstance || quitHandler.isQuitting()) return;
  // TaskPilot uses its own in-window controls. Removing Electron's default
  // application menu avoids AppKit representedObject warnings on macOS.
  Menu.setApplicationMenu(null);

  const configDir = app.getPath('userData');
  await initializeLogging(path.join(configDir, 'logs'));
  logger.info('[startup] TaskPilot starting');
  // The window opens before the stores load, so its splash covers that time.
  // Only the appearance is read first; initialize() reads the file again and
  // reports a failure on the splash.
  let prefs = await preferences.load(configDir).catch((error) => {
    logger.error('[startup] preferences could not be read', error);
    return preferences.defaults();
  });
  if (quitHandler.isQuitting()) return;
  // themeSource drives prefers-color-scheme in every window, so the CSS
  // follows the setting without the page needing to know about it.
  nativeTheme.themeSource = prefs.appearance.theme;

  const restart = () => {
    app.relaunch();
    app.quit();
  };
  const initialize = async () => {
    await applyPendingRestore(configDir, app.getVersion());
    // The packs that ship with the app; a broken one fails startup, on the splash.
    // electron-builder copies resources/courses/ into the bundle (extraResources).
    const builtinCourses = await courses.loadBuiltinCourses(
      app.isPackaged ? path.join(process.resourcesPath, 'courses') : path.join(app.getAppPath(), courses.BUILTIN_COURSES_DIR),
    );
    // Moves pre-repository files into place on the first start of this version.
    const repositories = await new RepositoryRegistry(configDir).load();
    // Everything below belongs to the open repository (or the unassigned data).
    const repoDir = repositories.dataDir();
    let config = await repositories.loadConfig();
    prefs = await preferences.load(configDir);
    nativeTheme.themeSource = prefs.appearance.theme;
    // Published packages must be known before the work package store loads, or
    // their saved progress would be dropped as unknown ids.
    const requirements = await new RequirementStore(repoDir).load();
    const store = await new WorkPackageStore(repoDir).load(requirements.listTasks());
    const activity = new ActivityLog(repoDir, { timeZone: env.businessTimeZone });
    const releases = await new ReleaseStore(repoDir).load();
    const tutor = await new TutorStore(repoDir).load();
    // Load mastery before opening the notes watcher, so a damaged global file
    // cannot leave an orphan watcher behind when startup is retried.
    const mastery = await new MasteryStore(configDir).load();
    // Notes follow the developer, not the repository.
    const notes = await new NoteStore(configDir, { trash: (file) => shell.trashItem(file) }).load();
    // Expired day files go at startup; a failure only leaves old files behind.
    activity.prune().catch((error) => logger.error('[activity] prune failed', error));

    ipcHandle = registerIpcHandlers(ipcMain, {
      store,
      configDir,
      builtinCourses,
      repositories,
      getConfig: () => config,
      setConfig: (next) => {
        config = next;
      },
      getPreferences: () => prefs,
      setPreferences: (next) => {
        prefs = next;
      },
      pathResolver: createPathResolver(),
      appVersion: app.getVersion(),
      requirements,
      activity,
      releases,
      tutor,
      notes,
      mastery,
      onStateChanged: (change) => {
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.webContents.isDestroyed()) window.webContents.send(CHANNELS.stateOnChanged, change);
        }
      },
      onPreferencesChanged: (next) => {
        nativeTheme.themeSource = next.appearance.theme;
        for (const window of BrowserWindow.getAllWindows()) {
          if (process.platform === 'darwin' && next.appearance.vibrancy) vibrantWindows.add(window);
          else vibrantWindows.delete(window);
          applyAppearance(window, next.appearance);
        }
      },
      shell: {
        restart,
        // openPath only receives configDir (app.getPath('userData')), never a
        // path from the renderer.
        revealPath: async (dir) => {
          const failure = await shell.openPath(dir);
          if (failure) throw Object.assign(new Error(failure), { code: 'open_failed' });
        },
        // Only reached with a path open_file.ts has confined to the workspace.
        revealFile: (file) => shell.showItemInFolder(file),
        // Only reached with an http(s) or mailto URL (checked in ipc/notes.ts).
        openUrl: (url) => shell.openExternal(url),
        pickDirectory: async (defaultPath) => {
          const options: OpenDialogOptions = { properties: ['openDirectory'], defaultPath: defaultPath ?? app.getPath('home') };
          const parent = BrowserWindow.getFocusedWindow();
          const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
          return result.canceled ? null : (result.filePaths[0] ?? null);
        },
        pickFile: async (defaultPath, filters) => {
          const options: OpenDialogOptions = { properties: ['openFile'], filters, defaultPath: defaultPath ?? app.getPath('home') };
          const parent = BrowserWindow.getFocusedWindow();
          const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
          return result.canceled ? null : (result.filePaths[0] ?? null);
        },
      },
      coding: {
        // electron-builder copies scripts/ into the bundle (extraResources).
        setupScript: app.isPackaged ? path.join(process.resourcesPath, 'scripts', 'setup-coding-agent-user.sh') : 'scripts/setup-coding-agent-user.sh',
      },
    });
  };

  const startup = createStartupGate(() => {
    initialization = initialize();
    return initialization;
  });
  // The renderer waits on this before any other call.
  registerContract(ipcMain, appContract, {
    restoreBackup: async () => {
      if (ipcHandle) throw codedError('请在设置的数据页恢复备份。', 'invalid_state');
      return restoreAtStartup(configDir, {
        pickDirectory: async () => {
          const result = await dialog.showOpenDialog({ title: '选择 TaskPilot 备份文件夹', properties: ['openDirectory'] });
          return result.canceled ? null : (result.filePaths[0] ?? null);
        },
        confirm: async (summary) =>
          (
            await dialog.showMessageBox({
              type: 'warning',
              title: '恢复备份并重启？',
              message: '恢复 TaskPilot 数据',
              detail: summary,
              buttons: ['取消', '恢复并重启'],
              defaultId: 0,
              cancelId: 0,
            })
          ).response === 1,
        restart,
      });
    },
    ready: async (retry) => {
      await startup.ready(retry === true);
      return true;
    },
  });
  createWindow(prefs.appearance);

  app.on('activate', () => {
    if (!quitHandler.isQuitting() && BrowserWindow.getAllWindows().length === 0) createWindow(prefs.appearance);
  });
});

// Stop running agents and flush their writes before quitting. An interrupted
// run is reported as failed on the next launch (see requirement_store.js).
const quitHandler = createQuitHandler({
  shutdown: async () => {
    // If Quit arrives on the splash, finish acquiring the stores before draining
    // them. A failed startup has already been logged and needs no second retry.
    await initialization?.catch(() => {});
    await ipcHandle?.shutdown();
  },
  flushLogs,
  quit: () => app.quit(),
});
app.on('before-quit', quitHandler.beforeQuit);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
