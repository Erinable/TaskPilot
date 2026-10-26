// Tool detection for any language: the version a command reports, as the
// settings page and the presets' setup probes show it. Never installs
// anything.
import { execFile } from 'node:child_process';

import { processEnv } from './env.ts';

// Reads a tool's version; injectable for tests.
export type ToolVersion = (command: string, args: string[], envPath?: string | null) => Promise<string | null>;

// The first line a tool prints for its version flag; null when it is missing.
export const toolVersion: ToolVersion = (command, args, envPath) =>
  new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        timeout: 5000,
        env: { ...processEnv(), ...(envPath ? { PATH: envPath } : {}), NO_UPDATE_NOTIFIER: '1' },
      },
      (error, stdout) => resolve(error ? null : stdout.trim().split('\n')[0] || null),
    );
  });
