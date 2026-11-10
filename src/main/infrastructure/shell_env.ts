// Builds the command PATH for desktop launches. Automatic discovery reads only
// bounded conventional installation directories and never executes shell rc files.
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import { env, processEnv } from './env.ts';
import { discoverToolPaths } from './tool_discovery.ts';
import type { DiscoveryOptions } from './tool_discovery.ts';
import { normalizeErrorCode, type ErrorCode } from '../../shared/error_codes.ts';

export const MARKER = '__TASKPILOT_PATH__';
const TIMEOUT_MS = 5000;
const SUPPORTED_SHELLS = new Set(['bash', 'zsh', 'sh', 'fish', 'dash', 'ksh']);

// The execFile shape readLoginShellPath() needs; injectable for tests.
export type RunFile = (
  file: string,
  args: string[],
  options: { timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv; cwd?: string; detached?: boolean; killSignal?: NodeJS.Signals },
  callback: (error: (Error & { killed?: boolean }) | null, stdout?: string | Buffer) => void,
) => unknown;

type PathError = { code: ErrorCode; message: string };
export interface ResolvedPath {
  source: 'auto' | 'inherit' | 'login-shell';
  path: string;
  error: PathError | null;
}

export interface PathResolver {
  inherited: string;
  resolve: (source: string, extraPaths?: readonly string[]) => Promise<ResolvedPath>;
  refresh: () => void;
}

export type ShellEnvErrorCode = 'unsupported_shell' | 'no_shell' | 'shell_timeout' | 'shell_no_path';

export class ShellEnvError extends Error {
  code: ShellEnvErrorCode;

  constructor(message: string, code: ShellEnvErrorCode) {
    super(message);
    this.name = 'ShellEnvError';
    this.code = code;
  }
}

// Shell banners are ignored; only the fenced PATH is accepted.
export const extractPath = (output: string): string | null => {
  const start = output.indexOf(MARKER);
  if (start === -1) return null;
  const end = output.indexOf(MARKER, start + MARKER.length);
  if (end === -1) return null;
  const value = output.slice(start + MARKER.length, end).trim();
  return value || null;
};

export const shellCommand = (shell: string): { file: string; args: string[] } => {
  const name = path.basename(shell);
  if (!SUPPORTED_SHELLS.has(name)) throw new ShellEnvError(`Unsupported login shell: ${name}`, 'unsupported_shell');
  const print = name === 'fish' ? `printf '%s%s%s' ${MARKER} (string join : $PATH) ${MARKER}` : `printf '%s%s%s' ${MARKER} "$PATH" ${MARKER}`;
  return { file: shell, args: ['-ilc', print] };
};

const userShell = () => {
  try {
    return os.userInfo().shell;
  } catch {
    return null;
  }
};
type ShellProcess = { pid?: number; kill?: (signal: NodeJS.Signals) => unknown };
const terminateShell = (child: ShellProcess | undefined) => {
  if (!child) return;
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
    else child.kill?.('SIGKILL');
  } catch {
    // It may already have exited between the deadline and its callback.
    try {
      child.kill?.('SIGKILL');
    } catch {
      // The process is gone.
    }
  }
};

export const readLoginShellPath = ({
  shell = env.shell ?? userShell(),
  run = execFile as unknown as RunFile,
  timeoutMs = TIMEOUT_MS,
}: { shell?: string | null; run?: RunFile; timeoutMs?: number } = {}): Promise<string> =>
  new Promise((resolve, reject) => {
    if (!shell || !path.isAbsolute(shell)) {
      reject(new ShellEnvError('No absolute login shell is configured', 'no_shell'));
      return;
    }
    let command: { file: string; args: string[] };
    try {
      command = shellCommand(shell);
    } catch (error) {
      reject(error);
      return;
    }
    let child: ShellProcess | undefined;
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      terminateShell(child);
      reject(new ShellEnvError('Login shell did not respond in time', 'shell_timeout'));
    }, timeoutMs);
    const finish = (error: (Error & { killed?: boolean }) | null, stdout: string | Buffer = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const value = extractPath(String(stdout));
      if (error?.killed) terminateShell(child);
      if (value) resolve(value);
      else if (error?.killed) reject(new ShellEnvError('Login shell did not respond in time', 'shell_timeout'));
      else reject(new ShellEnvError('Login shell did not report a PATH', 'shell_no_path'));
    };
    try {
      child = run(
        command.file,
        command.args,
        {
          timeout: timeoutMs,
          maxBuffer: 1024 * 1024,
          env: { ...processEnv(), TERM: 'dumb' },
          cwd: os.homedir(),
          detached: process.platform !== 'win32',
          killSignal: 'SIGKILL',
        },
        finish,
      ) as ShellProcess | undefined;
    } catch (error) {
      clearTimeout(timeout);
      settled = true;
      reject(error);
    }
  });

const pathError = (caught: unknown): PathError => {
  const error = caught as Error & { code?: string };
  return { code: normalizeErrorCode(error?.code), message: error?.message ?? String(caught) };
};
type Outcome<T> = { value: T; error: null } | { value: null; error: PathError };
const outcome = <T>(operation: () => Promise<T>): Promise<Outcome<T>> =>
  Promise.resolve()
    .then(operation)
    .then(
      (value) => ({ value, error: null }),
      (error: unknown) => ({ value: null, error: pathError(error) }),
    );
const safeDirectories = (directories: readonly string[]) =>
  directories.filter((directory) => path.isAbsolute(directory) && !directory.includes(path.delimiter) && !directory.includes('\0'));
const combine = (...parts: readonly string[][]) => [...new Set(safeDirectories(parts.flat()))].join(path.delimiter);

export const createPathResolver = ({
  inherited = env.path,
  read = readLoginShellPath,
  discover = discoverToolPaths,
  home,
  platform,
  toolHomes = env.toolHomes,
  systemPaths,
}: DiscoveryOptions & { read?: () => Promise<string>; discover?: (options: DiscoveryOptions) => Promise<string[]> } = {}): PathResolver => {
  let generation = 0;
  let shellCache: { generation: number; promise: Promise<Outcome<string>> } | null = null;
  let discoveryCache: { generation: number; promise: Promise<Outcome<string[]>> } | null = null;
  const loginShell = () => {
    if (shellCache?.generation !== generation) shellCache = { generation, promise: outcome(read) };
    return shellCache.promise;
  };
  const installed = () => {
    if (discoveryCache?.generation !== generation)
      discoveryCache = { generation, promise: outcome(() => discover({ inherited, home, platform, toolHomes, systemPaths })) };
    return discoveryCache.promise;
  };
  return {
    inherited,
    async resolve(source, extraPaths = []) {
      const extra = safeDirectories(extraPaths);
      if (source !== 'auto' && source !== 'login-shell') {
        // Explicit inheritance remains byte-for-byte compatible when no manual
        // directory was supplied, including its original order and separators.
        return {
          source: 'inherit',
          path: extra.length ? `${[...new Set(extra)].join(path.delimiter)}${inherited ? path.delimiter + inherited : ''}` : inherited,
          error: null,
        };
      }
      if (source === 'auto') {
        const found = await installed();
        return { source: 'auto', path: combine(extra, inherited.split(path.delimiter), found.value ?? []), error: found.error };
      }
      const [shell, found] = await Promise.all([loginShell(), installed()]);
      return {
        source: shell.error ? 'inherit' : 'login-shell',
        path: combine(extra, (shell.value ?? inherited).split(path.delimiter), found.value ?? []),
        error: shell.error ?? found.error,
      };
    },
    refresh() {
      generation += 1;
      shellCache = null;
      discoveryCache = null;
    },
  };
};
