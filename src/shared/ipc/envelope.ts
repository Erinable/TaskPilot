import type { ErrorCode } from '../error_codes.ts';

// Every IPC answer is an IpcResult; ErrorInfo is the error an agent run or a lookup records.

// Shaped like an Error but safe to send over IPC. `field` names the form
// input at fault, when there is one.
export type IpcFailure = { code: ErrorCode; message: string; field?: string };

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: IpcFailure };

// Error recorded on an agent run or a resolved PATH.
export type ErrorInfo = { code: ErrorCode; message: string };
