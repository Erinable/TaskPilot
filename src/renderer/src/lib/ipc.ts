// Unwraps the {ok, data} | {ok, error} envelope every IPC call returns.
import { normalizeErrorCode, type ErrorCode } from '@shared/error_codes.ts';
import type { IpcResult } from '@shared/ipc/envelope.ts';

export class IpcError extends Error {
  code: ErrorCode;
  // Which settings input the failure belongs to, when the main process knows.
  field?: string;

  constructor(message: string, code: unknown, field?: string) {
    super(message);
    this.name = 'IpcError';
    this.code = normalizeErrorCode(code);
    this.field = field;
  }
}

export const call = async <T>(promise: Promise<IpcResult<T>>) => {
  const response = await promise;
  if (!response.ok) throw new IpcError(response.error.message, response.error.code, response.error.field);
  return response.data;
};
