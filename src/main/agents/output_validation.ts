// Validation of untrusted model output shared by every agent: the CLI
// enforces each schema, but no agent relies on it.
import type { ErrorCode } from '../../shared/error_codes.ts';
import { CONTROL_CHARS } from '../../shared/text_rules.ts';

// Untrusted model output, once it is known to be an object.
export type RawObject = Record<string, unknown>;

export const isObject = (value: unknown): value is RawObject => Boolean(value) && typeof value === 'object';

export class AgentOutputError extends Error {
  code: ErrorCode;

  constructor(message: string) {
    super(message);
    this.name = 'AgentOutputError';
    this.code = 'agent_bad_output';
  }
}

// Typed as a declaration so calls narrow: TypeScript only treats a call as
// unreachable-after when the callee's type is written out.
export const fail: (path: string, problem: string) => never = (path, problem) => {
  throw new AgentOutputError(`${path} ${problem}`);
};

export const text = (value: unknown, path: string, maxLength: number): string => {
  if (typeof value !== 'string') fail(path, 'must be text');
  const trimmed = value.trim();
  if (!trimmed) fail(path, 'is empty');
  if ([...trimmed].length > maxLength) fail(path, `is longer than ${maxLength} characters`);
  if (CONTROL_CHARS.test(trimmed)) fail(path, 'contains control characters');
  return trimmed;
};

export const optionalText = (value: unknown, path: string, maxLength: number): string | undefined =>
  value === undefined ? undefined : text(value, path, maxLength);

export const list = (value: unknown, path: string, { min = 0, max }: { min?: number; max: number }): unknown[] => {
  if (!Array.isArray(value)) fail(path, 'must be a list');
  if (value.length < min) fail(path, `needs at least ${min} item(s)`);
  if (value.length > max) fail(path, `has more than ${max} items`);
  return value;
};

export const oneOf = <T extends string>(value: unknown, allowed: readonly T[], path: string): T => {
  if (!(allowed as readonly unknown[]).includes(value)) fail(path, `must be one of ${allowed.join(', ')}`);
  return value as T;
};

// A file scope entry: a relative path inside the repository. Rejects absolute
// paths, `..` segments, and Windows separators, then normalizes `./`.
export const scopePath = (value: unknown, path: string): string => {
  const entry = text(value, path, 200);
  if (entry.startsWith('/') || /^[a-zA-Z]:/.test(entry) || entry.includes('\\')) fail(path, 'must be a relative path');
  const segments = entry.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.length === 0) fail(path, 'is not a file path');
  if (segments.includes('..')) fail(path, 'must not contain ..');
  return segments.join('/');
};
