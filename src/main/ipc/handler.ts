// The IPC boundary: how a handler's outcome reaches the renderer.
import { asAgentError, codedError } from '../infrastructure/coded_error.ts';
import { normalizeErrorCode } from '../../shared/error_codes.ts';
import type { Channel } from '../../shared/ipc_channels.ts';
import type * as envelopeTypes from '../../shared/ipc/envelope.ts';
import type { Contract, HandlersOf } from '../../shared/ipc/contract.ts';

// Electron's ipcMain, or a stand-in exposing `handle`.
export type IpcMainLike = { handle(channel: Channel, listener: (event: unknown, ...args: unknown[]) => unknown): void };

// Convert arbitrary thrown values to a safe, closed-code wire shape.
export const toFailure = (error: unknown): { ok: false; error: envelopeTypes.IpcFailure } => {
  const info = asAgentError(error);
  const failure: envelopeTypes.IpcFailure = { code: normalizeErrorCode(info.code), message: info.message };
  if (error && typeof error === 'object' && 'field' in error && typeof error.field === 'string' && error.field) failure.field = error.field;
  return { ok: false, error: failure };
};
// Renderer arguments are untrusted, so handlers receive them as unknown.
type Handler<T> = (event: unknown, ...args: unknown[]) => T | Promise<T>;

// Wraps a handler so the renderer always receives {ok: true, data} or
// {ok: false, error} instead of an opaque rejected promise.
export const wrap =
  <T>(handler: Handler<T>) =>
  async (event: unknown, ...args: unknown[]): Promise<envelopeTypes.IpcResult<T>> => {
    try {
      return { ok: true, data: await handler(event, ...args) };
    } catch (error) {
      return toFailure(error);
    }
  };

const maintenance = new WeakSet<IpcMainLike>();
const activeCalls = new WeakMap<IpcMainLike, number>();

// A snapshot must not race another IPC mutation while stores are flushed and
// copied. The lock belongs to one IPC instance, including in integration tests.
export const withDataMaintenance = async <T>(ipcMain: IpcMainLike, operation: () => Promise<T>): Promise<T> => {
  if (maintenance.has(ipcMain) || (activeCalls.get(ipcMain) ?? 0) > 1) throw codedError('其他操作尚未完成，请稍后重试备份或恢复。', 'invalid_state');
  maintenance.add(ipcMain);
  try {
    return await operation();
  } finally {
    maintenance.delete(ipcMain);
  }
};

// Registers one handler per invoke channel of a contract table. The table
// types each handler's result, and a missing or extra handler does not compile.
export const registerContract = <C extends Contract>(ipcMain: IpcMainLike, contract: C, handlers: HandlersOf<C>) => {
  const byName = handlers as Record<string, (...args: unknown[]) => unknown>;
  for (const [name, spec] of Object.entries(contract)) {
    if (spec.kind === 'invoke')
      ipcMain.handle(
        spec.channel as Channel,
        wrap(async (_event, ...args) => {
          if (maintenance.has(ipcMain)) throw codedError('正在备份或准备恢复，请稍后重试。', 'invalid_state');
          activeCalls.set(ipcMain, (activeCalls.get(ipcMain) ?? 0) + 1);
          try {
            return await byName[name](...args);
          } finally {
            activeCalls.set(ipcMain, (activeCalls.get(ipcMain) ?? 1) - 1);
          }
        }),
      );
  }
};
