// The IPC contract: each channel is declared once, in a table under
// src/shared/ipc/<domain>.ts, with its name, argument tuple and result. The
// preload builds `window.taskpilot` from the tables, the main process registers
// handlers the tables type-check, and tests build fakes and clients from them.
// [人工决策-2026-10-27 15:20:30] 自研契约表，不引第三方 IPC 库（electron-trpc 停更、typed-ipc 会把 ipcRenderer 整个暴露给 renderer、interprocess 要求关闭 sandbox）。
import type { IpcResult } from './envelope.ts';

// renderer → main with an answer (ipcRenderer.invoke / ipcMain.handle). The
// optional fields only carry the types; they are never set.
export type InvokeSpec<A extends unknown[] = unknown[], R = unknown> = { kind: 'invoke'; channel: string; args?: A; result?: R };
// main → renderer push (webContents.send / ipcRenderer.on).
export type EventSpec<P = unknown> = { kind: 'event'; channel: string; payload?: P };
export type Contract = Record<string, InvokeSpec | EventSpec>;

export const invoke = <A extends unknown[], R>(channel: string): InvokeSpec<A, R> => ({ kind: 'invoke', channel });
export const event = <P>(channel: string): EventSpec<P> => ({ kind: 'event', channel });

type ArgsOf<S> = S extends InvokeSpec<infer A, unknown> ? A : never;
type ResultOf<S> = S extends InvokeSpec<unknown[], infer R> ? R : never;
type PayloadOf<S> = S extends EventSpec<infer P> ? P : never;

// What the renderer sees.
export type ClientOf<C extends Contract> = {
  [K in keyof C]: C[K] extends InvokeSpec
    ? (...args: ArgsOf<C[K]>) => Promise<IpcResult<ResultOf<C[K]>>>
    : (listener: (payload: PayloadOf<C[K]>) => void) => void;
};

// What the main process implements: as many arguments as declared, all unknown
// because the renderer is untrusted, and the declared result.
type Untrusted<A extends unknown[]> = { [I in keyof A]: unknown };
export type HandlersOf<C extends Contract> = {
  [K in keyof C as C[K] extends InvokeSpec ? K : never]: (...args: Untrusted<ArgsOf<C[K]>>) => ResultOf<C[K]> | Promise<ResultOf<C[K]>>;
};

// Electron's ipcRenderer, or a stand-in exposing `invoke` and `on`.
export type IpcRendererLike = {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (event: unknown, payload: unknown) => void): unknown;
};

// One function per declared channel, and nothing else: ipcRenderer itself never
// reaches the renderer.
const buildClient = <C extends Contract>(contract: C, ipcRenderer: IpcRendererLike) =>
  Object.fromEntries(
    Object.entries(contract).map(([name, spec]) => [
      name,
      spec.kind === 'invoke'
        ? (...args: unknown[]) => ipcRenderer.invoke(spec.channel, ...args)
        : (listener: (payload: unknown) => void) => void ipcRenderer.on(spec.channel, (_event, payload) => listener(payload)),
    ]),
  ) as ClientOf<C>;

export type ApiOf<T extends Record<string, Contract>> = { [N in keyof T]: ClientOf<T[N]> };

export const buildApi = <T extends Record<string, Contract>>(contracts: T, ipcRenderer: IpcRendererLike) =>
  Object.fromEntries(Object.entries(contracts).map(([namespace, contract]) => [namespace, buildClient(contract, ipcRenderer)])) as ApiOf<T>;

// `CHANNELS` keys: the namespace, then the method name capitalized (commit.preview → commitPreview).
type ChannelKey<T extends Record<string, Contract>> = { [N in keyof T & string]: `${N}${Capitalize<keyof T[N] & string>}` }[keyof T & string];

export const channelsOf = <T extends Record<string, Contract>>(contracts: T) =>
  Object.fromEntries(
    Object.entries(contracts).flatMap(([namespace, contract]) =>
      Object.entries(contract).map(([name, spec]) => [`${namespace}${name[0].toUpperCase()}${name.slice(1)}`, spec.channel]),
    ),
  ) as Record<ChannelKey<T>, string>;
