// The IPC boundary: how a handler's outcome reaches the renderer.
import type { CodedError } from '../coded_error.ts';
import type { Channel } from '../../shared/ipc_channels.ts';
import type * as ipc from '../../shared/ipc_types.ts';

// Electron's ipcMain, or a stand-in exposing `handle`.
export type IpcMainLike = { handle(channel: Channel, listener: (event: unknown, ...args: unknown[]) => unknown): void };

// Shaped like an Error but safe to send over IPC.
export const toFailure = (error: unknown): { ok: false; error: ipc.IpcFailure } => {
  const coded = error as CodedError;
  const failure: ipc.IpcFailure = { code: typeof coded.code === 'string' ? coded.code : 'unknown', message: coded.message };
  if (typeof coded.field === 'string' && coded.field) failure.field = coded.field;
  return { ok: false, error: failure };
};

// Renderer arguments are untrusted, so handlers receive them as unknown.
type Handler<T> = (event: unknown, ...args: unknown[]) => T | Promise<T>;

// Wraps a handler so the renderer always receives {ok: true, data} or
// {ok: false, error} instead of an opaque rejected promise.
export const wrap =
  <T>(handler: Handler<T>) =>
  async (event: unknown, ...args: unknown[]): Promise<ipc.IpcResult<T>> => {
    try {
      return { ok: true, data: await handler(event, ...args) };
    } catch (error) {
      return toFailure(error);
    }
  };
