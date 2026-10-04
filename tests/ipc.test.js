const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { CHANNELS, registerIpcHandlers } = require('../src/ipc');
const { listTasks } = require('../src/tasks');

function createFakeIpcMain() {
  const handlers = new Map();
  return { handlers, handle: (channel, handler) => handlers.set(channel, handler) };
}

test('registers a tasks:list handler that returns the task list', async () => {
  const ipcMain = createFakeIpcMain();
  registerIpcHandlers(ipcMain);
  const handler = ipcMain.handlers.get(CHANNELS.listTasks);
  assert.equal(typeof handler, 'function');
  assert.deepEqual(await handler({}), listTasks());
});

test('preload uses the same channel names as the main process', () => {
  // The sandboxed preload can't import ./ipc, so guard against drift.
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
  for (const channel of Object.values(CHANNELS)) {
    assert.ok(preload.includes(`'${channel}'`), `preload.js does not reference ${channel}`);
  }
});
