// window.taskpilot stand-ins built from the contract tables: every declared
// call is a vi.fn that rejects unless a test overrides it.
import { vi } from 'vitest';
import type { Mock } from 'vitest';

import { CONTRACTS } from '../../src/shared/ipc/contracts.ts';
import type { ContractApi } from '../../src/shared/ipc/contracts.ts';
import type { IpcResult } from '../../src/shared/ipc/envelope.ts';
import type { StateChange } from '../../src/shared/ipc/state.ts';

export type StateEvents = {
  onChanged: (listener: (change: StateChange) => void) => () => void;
  emit: (change: StateChange) => void;
};

export const stateEvents = (): StateEvents => {
  const listeners = new Set<(change: StateChange) => void>();
  const onChanged = (listener: (change: StateChange) => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  return { onChanged, emit: (change) => listeners.forEach((listener) => listener(change)) };
};

export const ok = <T>(data: T): Promise<IpcResult<T>> => Promise.resolve({ ok: true, data });

type FakeApi = { [N in keyof ContractApi]: { [K in keyof ContractApi[N]]: Mock<ContractApi[N][K]> } };
type Overrides = { [N in keyof ContractApi]?: Partial<ContractApi[N]> };

export const fakeApi = (overrides: Overrides = {}) => {
  const events = stateEvents();
  const api = Object.fromEntries(
    Object.entries(CONTRACTS).map(([namespace, contract]) => {
      const given = (overrides as Record<string, Record<string, (...args: unknown[]) => unknown>>)[namespace] ?? {};
      const methods = Object.fromEntries(
        Object.keys(contract).map((name) => [
          name,
          vi.fn(
            given[name] ??
              (namespace === 'state' && name === 'onChanged' ? events.onChanged : () => Promise.reject(new Error(`Not faked: ${namespace}.${name}`))),
          ),
        ]),
      );
      return [namespace, methods];
    }),
  ) as unknown as FakeApi;
  return Object.assign(api, { emitState: events.emit });
};
