const { app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme, shell } = require('electron');
const path = require('node:path');
const { registerIpcHandlers } = require('./ipc');
const { WorkPackageStore } = require('./work-package-store');
const { listTasks, setGeneratedTasks } = require('./tasks');
const { RequirementStore } = require('./requirement-store');
const workspace = require('./workspace');
const preferences = require('./preferences');
const { createPathResolver } = require('./shell-env');

// Matches --canvas in styles.css, so the first paint and any area the page
// doesn't cover use the theme's colour rather than a white flash.
const CANVAS = { light: '#eef1f8', dark: '#0d0f16' };
const canvasColor = () => (nativeTheme.shouldUseDarkColors ? CANVAS.dark : CANVAS.light);

/**
 * Native vibrancy (macOS only) lets the desktop show through the window. The
 * page's own backdrop is made transparent at the same time (see the
 * `vibrancy` class in styles.css), otherwise it would cover the effect.
 */
function applyAppearance(window, appearance) {
  if (process.platform !== 'darwin') return;
  if (appearance.vibrancy) {
    window.setVibrancy('under-window');
    window.setBackgroundColor('#00000000');
  } else {
    window.setVibrancy(null);
    window.setBackgroundColor(canvasColor());
  }
}

function createWindow(appearance) {
  const vibrant = process.platform === 'darwin' && appearance.vibrancy;
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: vibrant ? '#00000000' : canvasColor(),
    ...(vibrant ? { vibrancy: 'under-window', visualEffectState: 'followWindow' } : {}),
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 20, y: 22 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });

  // Keep the window background in step with a live light/dark switch.
  const syncBackground = () => {
    if (!window.isDestroyed() && !window.__taskpilotVibrant) window.setBackgroundColor(canvasColor());
  };
  window.__taskpilotVibrant = vibrant;
  nativeTheme.on('updated', syncBackground);
  window.on('closed', () => nativeTheme.off('updated', syncBackground));

  window.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  return window;
}

app.whenReady().then(async () => {
  // TaskPilot uses its own in-window controls. Removing Electron's default
  // application menu avoids AppKit representedObject warnings on macOS.
  Menu.setApplicationMenu(null);

  const configDir = app.getPath('userData');
  let config = await workspace.load(configDir);
  let prefs = await preferences.load(configDir);
  // Generated packages must be known before the work package store loads, or
  // their saved progress would be dropped as unknown ids.
  const requirements = await new RequirementStore(configDir).load();
  setGeneratedTasks(requirements.publishedPackages());
  const store = await new WorkPackageStore(configDir).load(listTasks());

  // themeSource drives prefers-color-scheme in every window, so the CSS
  // follows the setting without the page needing to know about it.
  nativeTheme.themeSource = prefs.appearance.theme;

  const ipc = registerIpcHandlers(ipcMain, {
    store,
    configDir,
    getConfig: () => config,
    setConfig: (next) => { config = next; },
    getPreferences: () => prefs,
    setPreferences: (next) => { prefs = next; },
    pathResolver: createPathResolver(),
    appVersion: app.getVersion(),
    requirements,
    onPreferencesChanged: (next) => {
      nativeTheme.themeSource = next.appearance.theme;
      for (const window of BrowserWindow.getAllWindows()) {
        window.__taskpilotVibrant = process.platform === 'darwin' && next.appearance.vibrancy;
        applyAppearance(window, next.appearance);
      }
    },
    // openPath only receives configDir (app.getPath('userData')), never a
    // path from the renderer.
    revealPath: async (dir) => {
      const failure = await shell.openPath(dir);
      if (failure) throw Object.assign(new Error(failure), { code: 'open_failed' });
    },
    pickDirectory: async (defaultPath) => {
      const options = { properties: ['openDirectory'], defaultPath: defaultPath ?? app.getPath('home') };
      const parent = BrowserWindow.getFocusedWindow();
      const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
      return result.canceled ? null : result.filePaths[0] ?? null;
    },
  });

  app.__taskpilotIpc = ipc;
  createWindow(prefs.appearance);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(prefs.appearance);
  });
});

// Stop running agents and flush their writes before quitting. An interrupted
// run is reported as failed on the next launch (see requirement-store.js).
let shuttingDown = false;
app.on('before-quit', (event) => {
  if (shuttingDown || !app.__taskpilotIpc) return;
  shuttingDown = true;
  event.preventDefault();
  const timeout = new Promise((resolve) => setTimeout(resolve, 3000));
  Promise.race([app.__taskpilotIpc.shutdown(), timeout]).finally(() => app.quit());
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
