// Sandboxed preloads can only require a limited set of modules, so the channel
// name is duplicated here instead of importing ./ipc.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('taskpilot', {
  listTasks: () => ipcRenderer.invoke('tasks:list'),
});
