// Unwraps the {ok, data} | {ok, error} envelope every IPC call returns.
import type { IpcResult } from '@shared/ipc/envelope.ts';

export class IpcError extends Error {
  code: string;
  // Which settings input the failure belongs to, when the main process knows.
  field?: string;

  constructor(message: string, code: string, field?: string) {
    super(message);
    this.code = code;
    this.field = field;
  }
}

export const call = async <T>(promise: Promise<IpcResult<T>>) => {
  const response = await promise;
  if (!response.ok) throw new IpcError(response.error.message, response.error.code, response.error.field);
  return response.data;
};
