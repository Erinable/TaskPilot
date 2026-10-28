import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import os from 'node:os';

import { logger } from '../infrastructure/logger.ts';
import { defaultAgentSettings, supportsAgentConfig, type AgentRuntimeConfig } from '../../shared/agent_runtime.ts';
import type { CodingEvent, CodingRuntimeStatus } from '../../shared/coding_types.ts';
import * as sandbox from './coding_sandbox.ts';
import type { SandboxContext } from './coding_sandbox.ts';
import {
  CODING_USER,
  CODING_WRAPPER_PATH,
  MAX_JSONL_LINE_BYTES,
  MAX_STDERR_BYTES,
  PROBE_TIMEOUT_MS,
  SUDO_PATH,
  CodingExecError,
  safeChildEnv,
  type CodingSession,
  type SpawnFn,
  type Spawned,
} from './coding_process.ts';
import { emptyUsage, parseRecord, redact } from './coding_protocol.ts';

const defaultSpawn: SpawnFn = (command, args, options) => nodeSpawn(command, [...args], options as never) as unknown as Spawned;

export interface RunCodingOptions {
  runName: string;
  prompt: string;
  config: AgentRuntimeConfig;
  timeoutMs?: number;
  signal?: AbortSignal;
  spawnFn?: SpawnFn;
  onEvent?: (event: CodingEvent) => void;
  // Set in sandbox mode: run as the current user inside TaskPilot's profile.
  sandbox?: SandboxContext;
}

export interface ProbeRuntimeOptions {
  config?: AgentRuntimeConfig;
  spawnFn?: SpawnFn;
  timeoutMs?: number;
  signal?: AbortSignal;
  sandbox?: SandboxContext;
}

export type RunCodingResult = CodingSession;

const killProcessTree = (child: Spawned, signal: NodeJS.Signals) => {
  const pid = child.pid;
  if (process.platform !== 'win32' && typeof pid === 'number' && pid > 0) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // A process without a group is still terminated below.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // The process may have exited between the two calls.
  }
};

const wrapperArgs = (runName: string, wrapperPath: string, user: string, config: AgentRuntimeConfig): string[] => [
  '-n',
  '-H',
  '-u',
  user,
  wrapperPath,
  'run',
  runName,
  config.cli,
  config.model,
  config.thinking,
];

export const runCoding = async ({
  runName,
  prompt,
  config,
  timeoutMs,
  signal,
  spawnFn = defaultSpawn,
  onEvent,
  sandbox: sandboxContext,
}: RunCodingOptions): Promise<RunCodingResult> => {
  if (!supportsAgentConfig('coding-agent', config)) throw new CodingExecError('Unsupported coding CLI configuration', 'coding_protocol');
  // The CLI's sign-in goes into the run's own home, never its real state folder.
  const runDir = sandboxContext ? sandbox.runDirOf(sandboxContext, runName) : null;
  if (sandboxContext && runDir) {
    try {
      await sandbox.seedAgentHome(sandboxContext, runDir, config.cli);
    } catch (caught) {
      throw new CodingExecError('Could not prepare the coding home', 'coding_spawn_failed', { stderr: redact(String(caught)) });
    }
  }
  const child: Spawned = (() => {
    try {
      if (sandboxContext) {
        const { command, args, options } = sandbox.runCommand(sandboxContext, runName, config);
        return spawnFn(command, args, options);
      }
      return spawnFn(SUDO_PATH, wrapperArgs(runName, CODING_WRAPPER_PATH, CODING_USER, config), {
        env: safeChildEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      });
    } catch (caught) {
      throw new CodingExecError('Could not start the coding runner', 'coding_spawn_failed', { stderr: redact(String(caught)) });
    }
  })();

  const events: CodingEvent[] = [];
  const usage = emptyUsage();
  const output = { text: '', bytes: 0 };
  const transcript = { bytes: 0 };
  let stderr = '';
  let lineParts: string[] = [];
  let lineBytes = 0;
  let protocolFailure: CodingExecError | null = null;
  let terminating = false;
  let timer: NodeJS.Timeout | undefined;
  let escalation: NodeJS.Timeout | undefined;

  const terminate = (reason: CodingExecError) => {
    if (terminating) return;
    terminating = true;
    protocolFailure = reason;
    try {
      child.stdin.end();
    } catch {
      // The stream can already be closed.
    }
    killProcessTree(child, 'SIGTERM');
    escalation = setTimeout(() => killProcessTree(child, 'SIGKILL'), 1000);
    escalation.unref?.();
  };

  const decoder = new TextDecoder();
  const consume = (chunk: unknown) => {
    if (protocolFailure) return;
    const decoded = decoder.decode(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array), { stream: true });
    let start = 0;
    for (let index = 0; index < decoded.length; index += 1) {
      if (decoded.charCodeAt(index) !== 10) continue;
      const part = decoded.slice(start, index);
      lineParts.push(part);
      lineBytes += Buffer.byteLength(part);
      if (lineBytes > MAX_JSONL_LINE_BYTES) {
        terminate(new CodingExecError('Codex emitted an oversized JSONL line', 'coding_oversized'));
        return;
      }
      try {
        const completeLine = lineParts.join('');
        if (completeLine.trim()) {
          const parsed = parseRecord(completeLine, config.cli, events, output, usage, onEvent, transcript);
          if (parsed.failed) throw new CodingExecError(parsed.failed, 'coding_protocol');
        }
      } catch (caught) {
        terminate(caught instanceof CodingExecError ? caught : new CodingExecError('Codex output could not be parsed', 'coding_protocol'));
        return;
      }
      lineParts = [];
      lineBytes = 0;
      start = index + 1;
    }
    const remainder = decoded.slice(start);
    lineParts.push(remainder);
    lineBytes += Buffer.byteLength(remainder);
    if (lineBytes > MAX_JSONL_LINE_BYTES) terminate(new CodingExecError('Codex emitted an oversized JSONL line', 'coding_oversized'));
  };
  child.stdout.on('data', consume);
  child.stderr.on('data', (chunk: unknown) => {
    if (stderr.length >= MAX_STDERR_BYTES) return;
    stderr += redact(String(chunk)).slice(0, MAX_STDERR_BYTES - stderr.length);
  });
  child.stdin.once?.('error', (error) => {
    if (!terminating) terminate(new CodingExecError('Could not send coding prompt', 'coding_stdin_failed', { stderr: redact(error.message) }));
  });

  const { promise, resolve, reject } = Promise.withResolvers<RunCodingResult>();
  let settled = false;
  const finish = (error?: CodingExecError) => {
    if (settled) return;
    settled = true;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (escalation !== undefined) {
      clearTimeout(escalation);
      escalation = undefined;
    }
    if (signal && abortListener) signal.removeEventListener('abort', abortListener);
    if (error) {
      // A failed or timed-out run may already have spent tokens.
      error.usage = usage;
      reject(error);
    } else resolve({ output: output.text, usage, events, sessionId: null });
  };
  child.once('error', (error) => {
    terminate(new CodingExecError('Coding runner failed to start', 'coding_spawn_failed', { stderr: redact(error.message) }));
  });
  child.once('close', (code, closeSignal) => {
    if (protocolFailure) {
      finish(
        new CodingExecError(protocolFailure.message, protocolFailure.code, { stderr: stderr || protocolFailure.stderr, exitCode: code, signal: closeSignal }),
      );
      return;
    }
    if (code !== 0) {
      finish(new CodingExecError(`Codex exited with status ${code ?? 'unknown'}`, 'coding_exit_failed', { stderr, exitCode: code, signal: closeSignal }));
      return;
    }
    try {
      const trailing = lineParts.join('') + decoder.decode();
      if (trailing.trim()) {
        const parsed = parseRecord(trailing, config.cli, events, output, usage, onEvent, transcript);
        if (parsed.failed) throw new CodingExecError(parsed.failed, 'coding_protocol');
      }
      if (!output.text.trim()) throw new CodingExecError(`${config.cli} exited successfully without an assistant response`, 'coding_protocol');
      finish();
    } catch (caught) {
      finish(caught instanceof CodingExecError ? caught : new CodingExecError('Codex output could not be parsed', 'coding_protocol'));
    }
  });
  const abortListener = () => terminate(new CodingExecError('Coding run was cancelled', 'coding_aborted'));
  signal?.addEventListener('abort', abortListener, { once: true });
  if (signal?.aborted) abortListener();
  if (timeoutMs !== undefined && timeoutMs > 0) {
    timer = setTimeout(() => terminate(new CodingExecError('Coding run timed out', 'coding_timeout')), timeoutMs);
    timer.unref?.();
  }
  try {
    child.stdin.end(prompt);
  } catch (caught) {
    terminate(new CodingExecError('Could not send coding prompt', 'coding_stdin_failed', { stderr: redact(String(caught)) }));
  }
  try {
    return await promise;
  } finally {
    // A refreshed token goes back; nothing else the agent wrote does.
    if (sandboxContext && runDir) await sandbox.syncCredentials(sandboxContext, runDir, config.cli).catch((error) => logger.error(error));
  }
};

const runtimeConfig = (config: AgentRuntimeConfig): CodingRuntimeStatus['config'] => ({ ...config, user: CODING_USER, timeoutMinutes: 30 });

const unavailableRuntime = (reason: string, config: AgentRuntimeConfig): CodingRuntimeStatus => ({
  backend: config.cli,
  protocol: `${config.cli}-jsonl`,
  boundary: 'separate-user',
  available: false,
  version: null,
  reason,
  config: runtimeConfig(config),
});

export const probeRuntime = async (options: ProbeRuntimeOptions = {}): Promise<CodingRuntimeStatus> => {
  const config = options.config ?? defaultAgentSettings()['coding-agent'];
  if (options.sandbox) {
    const status: CodingRuntimeStatus = {
      ...unavailableRuntime('', config),
      boundary: 'sandbox',
      config: { ...runtimeConfig(config), user: os.userInfo().username },
    };
    if (!supportsAgentConfig('coding-agent', config)) return { ...status, reason: 'Unsupported coding CLI configuration' };
    const result = await sandbox.probe(options.sandbox, config, { signal: options.signal });
    return { ...status, available: result.available, version: result.version, reason: result.reason };
  }
  const unavailable = (reason: string): CodingRuntimeStatus => unavailableRuntime(reason, config);
  if (!supportsAgentConfig('coding-agent', config)) return unavailable('Unsupported coding CLI configuration');
  const spawnFn = options.spawnFn ?? defaultSpawn;
  if (options.signal?.aborted) return unavailable('Probe was cancelled');
  let child: Spawned;
  try {
    child = spawnFn(SUDO_PATH, ['-n', '-H', '-u', CODING_USER, CODING_WRAPPER_PATH, 'status', config.cli, config.model, config.thinking], {
      env: safeChildEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
  } catch (caught) {
    return unavailable(`Could not start coding runtime probe: ${redact(String(caught))}`);
  }
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: unknown) => {
    if (Buffer.byteLength(stdout) < 64 * 1024) stdout += String(chunk).slice(0, 64 * 1024 - Buffer.byteLength(stdout));
  });
  child.stderr.on('data', (chunk: unknown) => {
    if (Buffer.byteLength(stderr) < MAX_STDERR_BYTES) stderr += redact(String(chunk)).slice(0, MAX_STDERR_BYTES - Buffer.byteLength(stderr));
  });
  const { promise, resolve } = Promise.withResolvers<CodingRuntimeStatus>();
  let done = false;
  let escalation: NodeJS.Timeout | undefined;
  const stop = () => {
    killProcessTree(child, 'SIGTERM');
    escalation = setTimeout(() => killProcessTree(child, 'SIGKILL'), 1000);
    escalation.unref?.();
  };
  const finish = (status: CodingRuntimeStatus, closed = false) => {
    if (done) {
      if (closed) clearTimeout(escalation);
      return;
    }
    done = true;
    clearTimeout(timer);
    if (closed) clearTimeout(escalation);
    if (options.signal) options.signal.removeEventListener('abort', abortListener);
    resolve(status);
  };
  const abortListener = () => {
    stop();
    finish(unavailable('Probe was cancelled'));
  };
  options.signal?.addEventListener('abort', abortListener, { once: true });
  child.once('error', (error) => finish(unavailable(`Coding runtime probe failed: ${redact(error.message)}`)));
  child.once('close', (code) => {
    const versionMatch = /^version=(.+)$/m.exec(stdout);
    const runtimeAvailable = /^available=true$/m.test(stdout);
    const statusReason = /^reason=(.+)$/m.exec(stdout);
    if (code !== 0 || !versionMatch || !runtimeAvailable) {
      finish(
        { ...unavailable(stderr.trim() || statusReason?.[1]?.trim() || 'Dedicated coding CLI is unavailable'), version: versionMatch?.[1]?.trim() ?? null },
        true,
      );
      return;
    }
    finish({ ...unavailable(statusReason?.[1]?.trim() ?? ''), available: true, version: versionMatch[1].trim() }, true);
  });
  const timer = setTimeout(() => {
    stop();
    finish(unavailable('Coding runtime probe timed out'));
  }, options.timeoutMs ?? PROBE_TIMEOUT_MS);
  timer.unref?.();
  return promise;
};

export const codingRunId = (): string => randomUUID();
