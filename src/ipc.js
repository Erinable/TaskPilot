const { listTasks } = require('./tasks');

const CHANNELS = {
  listTasks: 'tasks:list',
};

function registerIpcHandlers(ipcMain) {
  ipcMain.handle(CHANNELS.listTasks, () => listTasks());
}

module.exports = { CHANNELS, registerIpcHandlers };
