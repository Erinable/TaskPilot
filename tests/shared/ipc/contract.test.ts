// The contract tables (src/shared/ipc/contracts.ts) and what is derived from them.
import { expect, test } from 'vitest';
import { EventEmitter } from 'node:events';

import { CONTRACTS } from '../../../src/shared/ipc/contracts.ts';
import { CHANNELS } from '../../../src/shared/ipc_channels.ts';
import { buildApi, event } from '../../../src/shared/ipc/contract.ts';

test('every channel string is used once across the tables and CHANNELS', () => {
  const tableChannels = Object.values(CONTRACTS).flatMap((contract) => Object.values(contract).map((spec) => spec.channel));
  expect(new Set(tableChannels).size).toBe(tableChannels.length);
  const all = Object.values(CHANNELS);
  expect(all.filter((channel, index) => all.indexOf(channel) !== index)).toEqual([]);
});

test('disposing one push subscription stops its updates without dropping other listeners', () => {
  const events = new EventEmitter();
  const api = buildApi(
    { demo: { onChanged: event<number>('demo:changed') } },
    { invoke: async () => null, on: events.on.bind(events), removeListener: events.removeListener.bind(events) },
  );
  const first: number[] = [];
  const second: number[] = [];
  const disposeFirst = api.demo.onChanged((value) => first.push(value));
  const disposeSecond = api.demo.onChanged((value) => second.push(value));
  events.emit('demo:changed', {}, 1);
  disposeFirst();
  disposeFirst();
  events.emit('demo:changed', {}, 2);
  disposeSecond();
  events.emit('demo:changed', {}, 3);
  expect(first).toEqual([1]);
  expect(second).toEqual([1, 2]);
});
