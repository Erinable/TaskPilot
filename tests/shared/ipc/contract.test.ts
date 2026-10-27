// The contract tables (src/shared/ipc/contracts.ts) and what is derived from them.
import { expect, test, vi } from 'vitest';

import { buildApi, channelsOf, event, invoke } from '../../../src/shared/ipc/contract.ts';
import { CONTRACTS } from '../../../src/shared/ipc/contracts.ts';
import { CHANNELS } from '../../../src/shared/ipc_channels.ts';

test('every channel string is used once across the tables and CHANNELS', () => {
  const tableChannels = Object.values(CONTRACTS).flatMap((contract) => Object.values(contract).map((spec) => spec.channel));
  expect(new Set(tableChannels).size).toBe(tableChannels.length);
  const all = Object.values(CHANNELS);
  expect(all.filter((channel, index) => all.indexOf(channel) !== index)).toEqual([]);
});

test('CHANNELS keys are the namespace and the capitalized method name', () => {
  expect(channelsOf({ commit: { preview: invoke<[], null>('commit:preview') }, app: { onFullScreen: event<boolean>('window:full-screen') } })).toEqual({
    commitPreview: 'commit:preview',
    appOnFullScreen: 'window:full-screen',
  });
});

test('the built api invokes the declared channel and forwards events', async () => {
  const ipcRenderer = { invoke: vi.fn(async (..._args: unknown[]) => ({ ok: true, data: 'answer' })), on: vi.fn() };
  const api = buildApi({ demo: { get: invoke<[id: string, line?: number], string>('demo:get'), onChange: event<boolean>('demo:changed') } }, ipcRenderer);
  expect(await api.demo.get('a', 3)).toEqual({ ok: true, data: 'answer' });
  expect(ipcRenderer.invoke).toHaveBeenCalledWith('demo:get', 'a', 3);
  const listener = vi.fn();
  api.demo.onChange(listener);
  const [channel, forward] = ipcRenderer.on.mock.calls[0];
  expect(channel).toBe('demo:changed');
  forward({ sender: 'ignored' }, true);
  expect(listener).toHaveBeenCalledWith(true);
});
