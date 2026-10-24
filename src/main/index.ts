import { app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme, shell } from 'electron';
import type { OpenDialogOptions } from 'electron';
import path from 'node:path';

import { registerIpcHandlers } from './ipc.ts';
import type { IpcHandle } from './ipc.ts';
import { WorkPackageStore } from './work_package_store.ts';
import { listTasks, setGeneratedTasks } from './tasks.ts';
import { RequirementStore } from './requirement_store.ts';
import { ReleaseStore } from './release_store.ts';
import * as preferences from './preferences.ts';
import { createPathResolver } from './shell_env.ts';
import { env } from './env.ts';
import { ActivityLog } from './activity_log.ts';
import { RepositoryRegistry } from './repositories.ts';
import { TutorStore } from './tutor_store.ts';
import { NoteStore } from './note_store.ts';
import { CHANNELS } from '../shared/ipc_channels.ts';

// Matches --canvas in styles.css, so the first paint and any area the page
// doesn't cover use the theme's colour rather than a white flash.
const CANVAS = { light: '#eef1f8', dark: '#0d0f16' };
const canvasColor = () => (nativeTheme.shouldUseDarkColors ? CANVAS.dark : CANVAS.light);

type Appearance = { vibrancy: boolean };

// Windows showing native vibrancy; their background stays transparent.
const vibrantWindows = new WeakSet<BrowserWindow>();

// Set once the IPC handlers are registered, so quitting can shut them down.
let ipcHandle: IpcHandle | null = null;

// The packaged app is named TaskPilot, development runs as taskpilot; on a
// case-sensitive volume those are two directories. Both use this one.
app.setPath('userData', path.join(app.getPath('appData'), 'taskpilot'));

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
  const sendFullScreen = () => window.webContents.send(CHANNELS.windowFullScreen, window.isFullScreen());
  window.on('enter-full-screen', sendFullScreen);
  window.on('leave-full-screen', sendFullScreen);
  window.webContents.on('did-finish-load', sendFullScreen);

  if (env.rendererUrl) window.loadURL(env.rendererUrl);
  else window.loadFile(path.join(import.meta.dirname, '..', 'renderer', 'index.html'));
  return window;
};

app.whenReady().then(async () => {
  // TaskPilot uses its own in-window controls. Removing Electron's default
  // application menu avoids AppKit representedObject warnings on macOS.
  Menu.setApplicationMenu(null);

  const configDir = app.getPath('userData');
  // Moves pre-repository files into place on the first start of this version.
  const repositories = await new RepositoryRegistry(configDir).load();
  // Everything below belongs to the open repository (or the unassigned data).
  const repoDir = repositories.dataDir();
  let config = await repositories.loadConfig();
  let prefs = await preferences.load(configDir);
  // Generated packages must be known before the work package store loads, or
  // their saved progress would be dropped as unknown ids.
  const requirements = await new RequirementStore(repoDir).load();
  setGeneratedTasks(requirements.publishedPackages());
  const store = await new WorkPackageStore(repoDir).load(listTasks());
  const activity = new ActivityLog(repoDir, { timeZone: env.businessTimeZone });
  const releases = await new ReleaseStore(repoDir).load();
  const tutor = await new TutorStore(repoDir).load();
  // Notes follow the developer, not the repository.
  const notes = await new NoteStore(configDir, { trash: (file) => shell.trashItem(file) }).load();
  // Expired day files go at startup; a failure only leaves old files behind.
  activity.prune().catch((error) => console.error('[activity] prune failed', error));

  // themeSource drives prefers-color-scheme in every window, so the CSS
  // follows the setting without the page needing to know about it.
  nativeTheme.themeSource = prefs.appearance.theme;

  const ipc = registerIpcHandlers(ipcMain, {
    store,
    configDir,
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
    // electron-builder copies scripts/ into the bundle (extraResources).
    codingSetupScript: app.isPackaged ? path.join(process.resourcesPath, 'scripts', 'setup-coding-agent-user.sh') : 'scripts/setup-coding-agent-user.sh',
    requirements,
    activity,
    releases,
    tutor,
    notes,
    onPreferencesChanged: (next) => {
      nativeTheme.themeSource = next.appearance.theme;
      for (const window of BrowserWindow.getAllWindows()) {
        if (process.platform === 'darwin' && next.appearance.vibrancy) vibrantWindows.add(window);
        else vibrantWindows.delete(window);
        applyAppearance(window, next.appearance);
      }
    },
    // openPath only receives configDir (app.getPath('userData')), never a
    // path from the renderer.
    revealPath: async (dir) => {
      const failure = await shell.openPath(dir);
      if (failure) throw Object.assign(new Error(failure), { code: 'open_failed' });
    },
    // Only reached with a path open_file.ts has confined to the workspace.
    revealFile: (file) => shell.showItemInFolder(file),
    // Only reached with an http(s) or mailto URL (checked in ipc.ts).
    openUrl: (url) => shell.openExternal(url),
    pickDirectory: async (defaultPath) => {
      const options: OpenDialogOptions = { properties: ['openDirectory'], defaultPath: defaultPath ?? app.getPath('home') };
      const parent = BrowserWindow.getFocusedWindow();
      const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
  });

  ipcHandle = ipc;
  createWindow(prefs.appearance);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(prefs.appearance);
  });
});

// Stop running agents and flush their writes before quitting. An interrupted
// run is reported as failed on the next launch (see requirement_store.js).
let shuttingDown = false;
app.on('before-quit', (event) => {
  if (shuttingDown || !ipcHandle) return;
  shuttingDown = true;
  event.preventDefault();
  const timeout = new Promise((resolve) => setTimeout(resolve, 3000));
  Promise.race([ipcHandle.shutdown(), timeout]).finally(() => app.quit());
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
