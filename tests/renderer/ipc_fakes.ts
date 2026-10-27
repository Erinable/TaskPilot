// window.taskpilot stand-ins built from the contract tables: every declared
// call is a vi.fn that answers fail('not_faked') unless a test overrides it.
import { vi } from 'vitest';
import type { Mock } from 'vitest';

import { CONTRACTS } from '../../src/shared/ipc/contracts.ts';
import type { ContractApi } from '../../src/shared/ipc/contracts.ts';
import type { IpcResult } from '../../src/shared/ipc/envelope.ts';

export const ok = <T>(data: T): Promise<IpcResult<T>> => Promise.resolve({ ok: true, data });

// What a call nobody faked answers.
const fail = (code: string, message: string, field?: string): Promise<IpcResult<never>> => Promise.resolve({ ok: false, error: { code, message, field } });

type FakeApi = { [N in keyof ContractApi]: { [K in keyof ContractApi[N]]: Mock<ContractApi[N][K]> } };
type Overrides = { [N in keyof ContractApi]?: Partial<ContractApi[N]> };

export const fakeApi = (overrides: Overrides = {}): FakeApi =>
  Object.fromEntries(
    Object.entries(CONTRACTS).map(([namespace, contract]) => {
      const given = (overrides as Record<string, Record<string, (...args: unknown[]) => unknown>>)[namespace] ?? {};
      return [
        namespace,
        Object.fromEntries(Object.keys(contract).map((name) => [name, vi.fn(given[name] ?? (() => fail('not_faked', `${namespace}.${name}`)))])),
      ];
    }),
  ) as unknown as FakeApi;
