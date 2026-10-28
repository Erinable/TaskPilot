// Errors carrying a closed machine-readable code (and optional form field).
import { isErrorCode, normalizeErrorCode, type ErrorCode } from '../../shared/error_codes.ts';

export type CodedError = Error & { code?: unknown; field?: unknown };

export const codedError = (message: string, code: ErrorCode, field?: string): CodedError => {
  const error: CodedError = new Error(message);
  error.code = code;
  if (field) error.field = field;
  return error;
};

export const failWith: (message: string, code: ErrorCode, field?: string) => never = (message, code, field) => {
  throw codedError(message, code, field);
};

export type AgentError = { code: ErrorCode; message: string };

// Caught values may be primitives or third-party objects. Never trust their
// shape when persisting an agent failure.
export const asAgentError = (error: unknown): AgentError => {
  const message =
    error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
      ? error.message
      : typeof error === 'string'
        ? error
        : String(error);
  let rawCode: unknown;
  if (error && typeof error === 'object' && 'code' in error) rawCode = error.code;
  return { code: normalizeErrorCode(rawCode), message };
};

export const errorCode = (error: unknown): ErrorCode | undefined => {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  return isErrorCode(error.code) ? error.code : undefined;
};

export const requireString = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw codedError(`${name} must be a non-empty string`, 'invalid_argument');
  return value;
};
