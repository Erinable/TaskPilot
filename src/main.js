const { app, BrowserWindow, Menu, dialog, ipcMain } = require('electron');
const path = require('node:path');
const { registerIpcHandlers } = require('./ipc');
const { WorkPackageStore } = require('./work-package-store');
const { listTasks } = require('./tasks');
const workspace = require('./workspace');

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: '#f5f5f7',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });

  window.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(async () => {
  // TaskPilot uses its own in-window controls. Removing Electron's default
  // application menu avoids AppKit representedObject warnings on macOS.
  Menu.setApplicationMenu(null);

  const configDir = app.getPath('userData');
  let config = await workspace.load(configDir);
  const store = await new WorkPackageStore(configDir).load(listTasks());

  registerIpcHandlers(ipcMain, {
    store,
    configDir,
    getConfig: () => config,
    setConfig: (next) => { config = next; },
    pickDirectory: async (defaultPath) => {
      const options = { properties: ['openDirectory'], defaultPath: defaultPath ?? app.getPath('home') };
      const parent = BrowserWindow.getFocusedWindow();
      const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
      return result.canceled ? null : result.filePaths[0] ?? null;
    },
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
