import { test, vi } from 'vitest';
import assert from 'node:assert/strict';

import { registerContract, withDataMaintenance } from '../../../src/main/ipc/handler.ts';
import type { IpcMainLike } from '../../../src/main/ipc/handler.ts';
import { preferencesContract, dataContract } from '../../../src/shared/ipc/settings.ts';
import type { Channel } from '../../../src/shared/ipc_channels.ts';
import type { IpcResult } from '../../../src/shared/ipc/envelope.ts';
import * as preferences from '../../../src/main/app/preferences.ts';

const boundary = () => {
  const handlers = new Map<Channel, (event: unknown, ...args: unknown[]) => unknown>();
  const ipcMain: IpcMainLike = {
    handle: (channel, listener) => {
      handlers.set(channel, listener);
    },
  };
  const call = async (channel: Channel) => (await handlers.get(channel)!(null)) as IpcResult<unknown>;
  return { ipcMain, call };
};
const contract = { mutate: preferencesContract.set, snapshot: dataContract.backup };
const currentPreferences = () => preferences.toView(preferences.defaults());

test('backup maintenance refuses an outstanding IPC write before flushing or copying', async () => {
  const h = boundary();
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const copy = vi.fn(async () => null);
  registerContract(h.ipcMain, contract, {
    mutate: async () => {
      entered.resolve();
      await finish.promise;
      return currentPreferences();
    },
    snapshot: () => withDataMaintenance(h.ipcMain, copy),
  });
  const writing = h.call(preferencesContract.set.channel as Channel);
  await entered.promise;
  const blocked = await h.call(dataContract.backup.channel as Channel);
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.equal(blocked.error.code, 'invalid_state');
  assert.equal(copy.mock.calls.length, 0);
  finish.resolve();
  assert.equal((await writing).ok, true);
  assert.equal((await h.call(dataContract.backup.channel as Channel)).ok, true);
  assert.equal(copy.mock.calls.length, 1);
});

test('IPC mutations cannot enter a held snapshot and independent IPC instances keep working', async () => {
  const h = boundary();
  const other = boundary();
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const mutate = vi.fn(currentPreferences);
  registerContract(h.ipcMain, contract, {
    mutate,
    snapshot: () =>
      withDataMaintenance(h.ipcMain, async () => {
        entered.resolve();
        await finish.promise;
        return null;
      }),
  });
  registerContract(other.ipcMain, contract, { mutate: currentPreferences, snapshot: async () => null });
  const copying = h.call(dataContract.backup.channel as Channel);
  await entered.promise;
  const blocked = await h.call(preferencesContract.set.channel as Channel);
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.equal(blocked.error.code, 'invalid_state');
  assert.equal(mutate.mock.calls.length, 0);
  assert.equal((await other.call(preferencesContract.set.channel as Channel)).ok, true);
  finish.resolve();
  assert.equal((await copying).ok, true);
  assert.equal((await h.call(preferencesContract.set.channel as Channel)).ok, true);
  assert.equal(mutate.mock.calls.length, 1);
});

test('a failed maintenance operation releases the lock and active-call count', async () => {
  const h = boundary();
  let fail = true;
  registerContract(h.ipcMain, contract, {
    mutate: currentPreferences,
    snapshot: () =>
      withDataMaintenance(h.ipcMain, async () => {
        if (fail) throw new Error('copy failed');
        return null;
      }),
  });
  assert.equal((await h.call(dataContract.backup.channel as Channel)).ok, false);
  assert.equal((await h.call(preferencesContract.set.channel as Channel)).ok, true);
  fail = false;
  assert.equal((await h.call(dataContract.backup.channel as Channel)).ok, true);
});
