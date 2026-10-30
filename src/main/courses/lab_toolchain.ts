// A lab's toolchain under the self-check's sandbox: the variables and home
// folders the sandbox opens for it, the sandbox-exec command line `make
// grade` (./lab_verify.ts) and the tool probe share, and the probe itself,
// which runs each tool's version flag the way the grader will run the tool.
// A toolchain missing under the sandbox is reported before any model call
// is paid for, never mistaken for a broken lab.
//
// SECURITY: only the named toolchain's variables reach the sandbox; a legacy
// lab repository without a toolchain gets every preset's, as before.
import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { env } from '../infrastructure/env.ts';
import { codedError } from '../infrastructure/coded_error.ts';
import { SANDBOX_EXEC_PATH, buildProfile, toolchainRoots } from '../coding/coding_sandbox.ts';
import { PRESETS, presetById } from '../checking/presets/index.ts';
import { TOOLCHAINS } from '../../shared/lab_toolchains.ts';
import type { LabToolchainId } from '../../shared/lab_toolchains.ts';
import type { LabToolchainCheck } from '../../shared/ipc/requirements.ts';

const PROBE_TIMEOUT_MS = 10_000;

export const sandboxAvailable = () => process.platform === 'darwin' && fs.existsSync(SANDBOX_EXEC_PATH);

// The error a run stops with when a check is not ready: sandbox_unavailable
// without Seatbelt, else toolchain_missing naming the missing tools.
export const toolchainMissing = (check: LabToolchainCheck) =>
  check.problem === 'sandbox_unavailable'
    ? codedError('The lab self-check runs generated code only inside the macOS sandbox', 'sandbox_unavailable')
    : codedError(
        `The ${check.id} toolchain is missing under the sandbox: ${check.tools
          .filter((tool) => tool.version === null)
          .map((tool) => tool.command)
          .join(', ')}`,
        'toolchain_missing',
      );

// The presets whose sandbox variables and folders a toolchain needs: C needs
// none, Rust and Python their own preset's; null (a lab repository from
// before toolchains) every one.
const presetsFor = (toolchain: LabToolchainId | null) => {
  if (toolchain === null) return PRESETS;
  if (toolchain === 'c') return [];
  const preset = presetById(toolchain);
  if (!preset) throw new Error(`No preset for lab toolchain ${toolchain}`);
  return [preset];
};

// The sandbox-exec arguments that run `command` in `root` with the network
// denied, HOME set to `root` and only PATH, TMPDIR, LANG and the toolchain's
// variables in the environment. rustup's toolchains are read where it
// installed them; caches go under `root`.
export const sandboxArgs = ({
  root,
  home,
  envPath,
  toolchain,
  command,
}: {
  root: string;
  home: string;
  envPath: string | null | undefined;
  toolchain: LabToolchainId | null;
  command: string[];
}): string[] => {
  const pathValue = envPath || env.path;
  const presets = presetsFor(toolchain);
  const readable = [...toolchainRoots(home, pathValue.split(':').filter(Boolean), null), ...presets.flatMap((preset) => preset.sandboxRead(home))];
  const profile = buildProfile({ home, runDir: root, writable: [], readable, offline: true });
  const toolchainEnv = Object.entries(Object.assign({}, ...presets.map((preset) => preset.sandboxEnv(root, home)))).map(([name, value]) => `${name}=${value}`);
  // Later assignments win in env(1), so a preset cannot replace these.
  return ['-p', profile, '/usr/bin/env', '-i', ...toolchainEnv, `PATH=${pathValue}`, `HOME=${root}`, `TMPDIR=${os.tmpdir()}`, 'LANG=en_US.UTF-8', ...command];
};

const execFile = promisify(execFileCallback);

// Checks a toolchain's tools; the verify and generation runs take it as a
// dependency so tests can replace it.
export type ToolchainProbe = (toolchain: LabToolchainId, options: { envPath?: string | null; signal?: AbortSignal }) => Promise<LabToolchainCheck>;

// The first line a tool printed for its version flag (some print it on
// stderr); null when it is missing or failed.
const firstLine = async (args: string[], cwd: string, signal?: AbortSignal): Promise<string | null> => {
  try {
    const { stdout, stderr } = await execFile(SANDBOX_EXEC_PATH, args, { cwd, timeout: PROBE_TIMEOUT_MS, signal });
    return stdout.trim().split('\n')[0] || stderr.trim().split('\n')[0] || null;
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
};

// Runs each tool's version flag under the grader's sandbox, in a scratch
// folder. Without Seatbelt nothing runs: every version is null and the
// problem says why.
export const sandboxProbe =
  (home = os.homedir()): ToolchainProbe =>
  async (toolchain, { envPath, signal }) => {
    const { tools } = TOOLCHAINS[toolchain];
    if (!sandboxAvailable())
      return { id: toolchain, tools: tools.map(({ command, install }) => ({ command, version: null, install })), ready: false, problem: 'sandbox_unavailable' };
    const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'taskpilot-lab-probe-')));
    try {
      const checked = await Promise.all(
        tools.map(async ({ command, versionArgs, install }) => ({
          command,
          version: await firstLine(sandboxArgs({ root, home, envPath, toolchain, command: [command, ...versionArgs] }), root, signal),
          install,
        })),
      );
      return { id: toolchain, tools: checked, ready: checked.every((tool) => tool.version !== null), problem: null };
    } finally {
      await fsp.rm(root, { recursive: true, force: true, maxRetries: 3 });
    }
  };
