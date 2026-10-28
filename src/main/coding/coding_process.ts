import type { CodingEvent, CodingUsage } from '../../shared/coding_types.ts';

export const CODING_WRAPPER_PATH = '/usr/local/libexec/taskpilot-coding-wrapper';
export const CODING_USER = 'taskpilot-coder';
export const SUDO_PATH = '/usr/bin/sudo';
export const CODING_PATH = '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
export const MAX_JSONL_LINE_BYTES = 4 * 1024 * 1024;
export const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
export const MAX_STDERR_BYTES = 64 * 1024;
export const MAX_TRANSCRIPT_BYTES = 32 * 1024 * 1024;
export const PROBE_TIMEOUT_MS = 10_000;

export type CodingExecErrorCode =
  'coding_spawn_failed' | 'coding_exit_failed' | 'coding_aborted' | 'coding_timeout' | 'coding_protocol' | 'coding_oversized' | 'coding_stdin_failed';

export class CodingExecError extends Error {
  readonly code: CodingExecErrorCode;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  // Tokens and cost the CLI reported before the run failed; set by runCoding.
  usage: CodingUsage | null = null;

  constructor(message: string, code: CodingExecErrorCode, options: { stderr?: string; exitCode?: number | null; signal?: NodeJS.Signals | null } = {}) {
    super(message);
    this.name = 'CodingExecError';
    this.code = code;
    this.stderr = options.stderr ?? '';
    this.exitCode = options.exitCode ?? null;
    this.signal = options.signal ?? null;
  }
}

// The only environment inherited by the unprivileged sudo invocation.
export const safeChildEnv = (): NodeJS.ProcessEnv => ({
  PATH: CODING_PATH,
  LANG: 'C',
  LC_ALL: 'C',
  NO_COLOR: '1',
  TERM: 'dumb',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSCOPE: '1',
});

export type WritableInput = {
  end: (chunk?: string | Uint8Array) => void;
  once?: (event: string, listener: (error: Error) => void) => unknown;
};
export type ReadableOutput = { on: (event: string, listener: (chunk: unknown) => void) => unknown };
export type Spawned = {
  pid?: number;
  stdin: WritableInput;
  stdout: ReadableOutput;
  stderr: ReadableOutput;
  once: {
    (event: 'error', listener: (error: Error) => void): unknown;
    (event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  };
  kill: (signal?: NodeJS.Signals) => boolean;
};

export type SpawnFn = (command: string, args: readonly string[], options: Record<string, unknown>) => Spawned;

export interface CodingSession {
  output: string;
  usage: CodingUsage;
  events: CodingEvent[];
  sessionId: null;
}

export type RunCodingResult = CodingSession;
