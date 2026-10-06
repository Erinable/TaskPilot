// Resolves the PATH that verification commands run with.
//
// An app launched from Finder or the Dock inherits launchd's minimal PATH, not
// the one the user's shell builds from ~/.zshrc and friends, so tools installed
// by nvm or Homebrew are often missing. The 'login-shell' source asks the
// user's own shell for its PATH once and caches the answer.
//
// SECURITY: the shell runs with a fixed argument list; nothing from the
// workspace config, preferences, or work packages is passed to it. The shell
// path is the user's own login shell (SHELL), which already runs their rc
// files every time they open a terminal.
import { execFile } from 'node:child_process';
import path from 'node:path';

import { env, processEnv } from './env.ts';

export const MARKER = '__TASKPILOT_PATH__';
const TIMEOUT_MS = 5000;
const SUPPORTED_SHELLS = new Set(['bash', 'zsh', 'sh', 'fish', 'dash', 'ksh']);

// The execFile shape readLoginShellPath() needs; injectable for tests.
export type RunFile = (
  file: string,
  args: string[],
  options: { timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv },
  callback: (error: (Error & { killed?: boolean }) | null, stdout?: string | Buffer) => void,
) => unknown;

// The PATH a verification command runs with, and where it came from.
export interface ResolvedPath {
  source: 'inherit' | 'login-shell';
  path: string;
  error: { code: string; message: string } | null;
}

export interface PathResolver {
  inherited: string;
  resolve: (source: string) => Promise<ResolvedPath>;
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

// Pulls PATH out of shell output. rc files may print banners or warnings, so
// the value is fenced by a marker on both sides and anything else is ignored.
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
  if (!SUPPORTED_SHELLS.has(name)) {
    throw new ShellEnvError(`Unsupported login shell: ${name}`, 'unsupported_shell');
  }
  // fish keeps PATH as a list, so join it explicitly.
  const print = name === 'fish'
    ? `printf '%s%s%s' ${MARKER} (string join : $PATH) ${MARKER}`
    : `printf '%s%s%s' ${MARKER} "$PATH" ${MARKER}`;
  // -i is needed for zsh/bash to source the rc files where nvm and friends
  // usually live; -l picks up profile files.
  return { file: shell, args: ['-ilc', print] };
};

export const readLoginShellPath = (
  { shell = env.shell, run = execFile as unknown as RunFile, timeoutMs = TIMEOUT_MS }: { shell?: string | null; run?: RunFile; timeoutMs?: number } = {},
): Promise<string> =>
  new Promise((resolve, reject) => {
    if (!shell || !path.isAbsolute(shell)) {
      reject(new ShellEnvError('No login shell is configured (SHELL is unset)', 'no_shell'));
      return;
    }
    let command: { file: string; args: string[] };
    try {
      command = shellCommand(shell);
    } catch (error) {
      reject(error);
      return;
    }
    run(command.file, command.args, { timeout: timeoutMs, maxBuffer: 1024 * 1024, env: { ...processEnv(), TERM: 'dumb' } },
      (error, stdout = '') => {
        // rc files sometimes exit non-zero after printing PATH; trust the marker.
        const value = extractPath(String(stdout));
        if (value) resolve(value);
        else if (error?.killed) reject(new ShellEnvError('Login shell did not respond in time', 'shell_timeout'));
        else reject(new ShellEnvError('Login shell did not report a PATH', 'shell_no_path'));
      });
  });

// Caches the login-shell PATH for the session; `refresh()` re-reads it after
// the user changes their shell config.
export const createPathResolver = (
  { inherited = env.path, read = readLoginShellPath }: { inherited?: string; read?: () => Promise<string> } = {},
): PathResolver => {
  let cached: string | null = null;
  let pending: Promise<string> | null = null;

  const loginShell = async (): Promise<string> => {
    if (cached !== null) return cached;
    pending ??= read().then((value) => { cached = value; return value; }).finally(() => { pending = null; });
    return pending;
  };

  return {
    inherited,
    // Never throws: a failing shell falls back to the inherited PATH.
    async resolve(source) {
      if (source !== 'login-shell') return { source: 'inherit', path: inherited, error: null };
      try {
        return { source: 'login-shell', path: await loginShell(), error: null };
      } catch (caught) {
        const error = caught as Error & { code?: string };
        return { source: 'inherit', path: inherited, error: { code: error.code ?? 'unknown', message: error.message } };
      }
    },
    refresh() {
      cached = null;
    },
  };
};
