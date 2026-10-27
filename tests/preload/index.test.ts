// The preload exposes exactly the declared calls (src/preload/index.ts).
import { expect, test, vi } from 'vitest';

import { CONTRACTS } from '../../src/shared/ipc/contracts.ts';

const exposed: Record<string, unknown> = {};
const ipcRenderer = { invoke: vi.fn(async () => ({ ok: true, data: null })), on: vi.fn() };
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld: (key: string, api: unknown) => (exposed[key] = api) }, ipcRenderer }));

test('each contract namespace exposes its table and calls only its channels', async () => {
  process.argv.push('--taskpilot-time-zone=Asia/Shanghai');
  await import('../../src/preload/index.ts');
  const api = exposed.taskpilot as Record<string, Record<string, (...args: unknown[]) => unknown>>;
  for (const [namespace, contract] of Object.entries(CONTRACTS)) {
    expect(api[namespace], namespace).toBeDefined();
    expect(Object.keys(api[namespace]).sort(), namespace).toEqual(Object.keys(contract).sort());
    for (const [name, spec] of Object.entries(contract)) {
      ipcRenderer.invoke.mockClear();
      await api[namespace][name]('arg');
      expect(ipcRenderer.invoke).toHaveBeenCalledWith(spec.channel, 'arg');
    }
  }
  // ipcRenderer itself is never handed over.
  expect(Object.values(api)).not.toContain(ipcRenderer);
});
