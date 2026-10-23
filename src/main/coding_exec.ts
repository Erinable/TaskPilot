import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { defaultAgentSettings, supportsAgentConfig, type AgentRuntimeConfig } from '../shared/agent_runtime.ts';
import type { CodingEvent, CodingRuntimeStatus, CodingUsage } from '../shared/coding_types.ts';
import os from 'node:os';
import * as sandbox from './coding_sandbox.ts';
import type { SandboxContext } from './coding_sandbox.ts';
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

  constructor(message: string, code: CodingExecErrorCode, options: { stderr?: string; exitCode?: number | null; signal?: NodeJS.Signals | null } = {}) {
    super(message);
    this.name = 'CodingExecError';
    this.code = code;
    this.stderr = options.stderr ?? '';
    this.exitCode = options.exitCode ?? null;
    this.signal = options.signal ?? null;
  }
}

/** The only environment inherited by the unprivileged sudo invocation. */
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

type WritableInput = {
  end: (chunk?: string | Uint8Array) => void;
  once?: (event: string, listener: (error: Error) => void) => unknown;
};
type ReadableOutput = { on: (event: string, listener: (chunk: unknown) => void) => unknown };
type Spawned = {
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

export interface CodingSession {
  output: string;
  usage: CodingUsage;
  events: CodingEvent[];
  sessionId: null;
}

export type RunCodingResult = CodingSession;

const emptyUsage = (): CodingUsage => ({
  inputTokens: null,
  outputTokens: null,
  cachedInputTokens: null,
  reasoningTokens: null,
  costUsd: null,
});

const redact = (value: string): string =>
  value
    .replace(/(sk-[A-Za-z0-9_-]{12,})/g, '[REDACTED_TOKEN]')
    .replace(/((?:api[_-]?key|token|secret|password)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]');

const textOf = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join('');
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of ['text', 'value', 'content']) {
      if (key in record) {
        const text = textOf(record[key]);
        if (text) return text;
      }
    }
  }
  return '';
};

const eventAt = () => new Date().toISOString();

type EventSink = (event: CodingEvent) => void;

const addEvent = (events: CodingEvent[], type: CodingEvent['type'], text: string, sink?: EventSink, transcript?: { bytes: number }) => {
  if (!text) return;
  const remaining = MAX_TRANSCRIPT_BYTES - (transcript?.bytes ?? 0);
  if (remaining <= 0) return;
  const bounded = Buffer.byteLength(text) <= remaining ? text : Buffer.from(text).subarray(0, remaining).toString('utf8');
  if (transcript) transcript.bytes += Buffer.byteLength(bounded);
  const event = { sequence: events.length, at: eventAt(), type, text: bounded } satisfies CodingEvent;
  events.push(event);
  try {
    sink?.(event);
  } catch {
    // Event observers must not interrupt the coding run.
  }
};

const usageNumber = (record: Record<string, unknown>, key: string): number | null =>
  typeof record[key] === 'number' && Number.isFinite(record[key]) ? record[key] : null;

const parseRecord = (
  raw: string,
  cli: AgentRuntimeConfig['cli'],
  events: CodingEvent[],
  output: { text: string; bytes: number },
  usage: CodingUsage,
  sink?: EventSink,
  transcript?: { bytes: number },
): { failed?: string } => {
  let record: unknown;
  try {
    record = JSON.parse(raw);
  } catch {
    throw new CodingExecError('Codex emitted invalid JSONL', 'coding_protocol');
  }
  if (!record || typeof record !== 'object') return {};
  const value = record as Record<string, unknown>;
  const type = typeof value.type === 'string' ? value.type : '';
  if (cli !== 'codex') {
    const message = (value.message && typeof value.message === 'object' ? value.message : {}) as Record<string, unknown>;
    const part = (value.part && typeof value.part === 'object' ? value.part : {}) as Record<string, unknown>;
    const nativeError = value.error ?? value.error_message ?? message.error;
    const failedEvent =
      type === 'error' ||
      type.endsWith('.error') ||
      type === 'agent_error' ||
      value.is_error === true ||
      message.stopReason === 'error' ||
      value.stopReason === 'error' ||
      (cli === 'claude' && type === 'result' && value.is_error === true) ||
      (cli === 'pi' && type === 'agent_end' && Boolean(nativeError));
    if (failedEvent) {
      const reason = redact(textOf(nativeError ?? value.message ?? value.detail ?? value.result) || `${cli} reported an error`);
      addEvent(events, 'error', reason, sink, transcript);
      return { failed: reason };
    }

    const assistantMessage =
      (cli === 'claude' && type === 'assistant') ||
      (cli === 'pi' && type === 'message_end' && (!message.role || message.role === 'assistant')) ||
      (cli === 'grok' && ['assistant', 'message', 'message_end'].includes(type) && (!message.role || message.role === 'assistant'));
    const opencodeText = cli === 'opencode' && type === 'text';
    const blocks = assistantMessage && Array.isArray(message.content) ? message.content : [];
    const chunks: string[] = [];
    if (assistantMessage && typeof message.content === 'string') chunks.push(message.content);
    for (const rawBlock of blocks) {
      if (!rawBlock || typeof rawBlock !== 'object') continue;
      const block = rawBlock as Record<string, unknown>;
      if (block.type === 'thinking' || block.type === 'reasoning') {
        addEvent(events, 'thinking', textOf(block.thinking ?? block.text), sink, transcript);
      } else if (block.type === 'tool_use' || block.type === 'tool_call') {
        addEvent(events, 'tool', textOf(block.name ?? block.tool ?? block.id), sink, transcript);
      } else if (block.type === 'text') chunks.push(textOf(block.text));
    }
    if (cli === 'pi' && type === 'tool_execution_start') addEvent(events, 'tool', textOf(value.toolName ?? value.tool_name ?? value.name), sink, transcript);
    if (cli === 'opencode' && type === 'tool') addEvent(events, 'tool', textOf(part.tool ?? value.tool ?? value.name), sink, transcript);
    if (cli === 'opencode' && (type === 'reasoning' || part.type === 'reasoning'))
      addEvent(events, 'thinking', textOf(part.text ?? value.text), sink, transcript);
    if (opencodeText) chunks.push(textOf(part.text ?? value.text));
    if (cli === 'grok' && assistantMessage && !chunks.length) chunks.push(textOf(message.content ?? value.content ?? value.text));
    const text = chunks.join('');
    if (text) {
      const bytes = Buffer.byteLength(text);
      if (output.bytes + bytes > MAX_OUTPUT_BYTES) throw new CodingExecError(`${cli} output exceeded the limit`, 'coding_oversized');
      output.bytes += bytes;
      output.text += `${output.text ? '\n' : ''}${text}`;
      addEvent(events, 'text', text, sink, transcript);
    }
    const usageValue = (
      message.usage && typeof message.usage === 'object' ? message.usage : value.usage && typeof value.usage === 'object' ? value.usage : {}
    ) as Record<string, unknown>;
    usage.inputTokens =
      usageNumber(usageValue, 'input_tokens') ?? usageNumber(usageValue, 'inputTokens') ?? usageNumber(usageValue, 'prompt_tokens') ?? usage.inputTokens;
    usage.outputTokens =
      usageNumber(usageValue, 'output_tokens') ?? usageNumber(usageValue, 'outputTokens') ?? usageNumber(usageValue, 'completion_tokens') ?? usage.outputTokens;
    usage.cachedInputTokens =
      usageNumber(usageValue, 'cache_read_input_tokens') ??
      usageNumber(usageValue, 'cached_input_tokens') ??
      usageNumber(usageValue, 'cached_tokens') ??
      usage.cachedInputTokens;
    usage.reasoningTokens = usageNumber(usageValue, 'reasoning_tokens') ?? usageNumber(usageValue, 'reasoning_output_tokens') ?? usage.reasoningTokens;
    usage.costUsd = usageNumber(value, 'total_cost_usd') ?? usageNumber(usageValue, 'cost_usd') ?? usage.costUsd;
    // OpenCode reports each step's tokens and cost on step_finish; a run is their sum.
    if (cli === 'opencode' && type === 'step_finish' && part.tokens && typeof part.tokens === 'object') {
      const tokens = part.tokens as Record<string, unknown>;
      const cache = (tokens.cache && typeof tokens.cache === 'object' ? tokens.cache : {}) as Record<string, unknown>;
      const add = (current: number | null, next: number | null) => (next === null ? current : (current ?? 0) + next);
      usage.inputTokens = add(usage.inputTokens, usageNumber(tokens, 'input'));
      usage.outputTokens = add(usage.outputTokens, usageNumber(tokens, 'output'));
      usage.cachedInputTokens = add(usage.cachedInputTokens, usageNumber(cache, 'read'));
      usage.reasoningTokens = add(usage.reasoningTokens, usageNumber(tokens, 'reasoning'));
      usage.costUsd = add(usage.costUsd, usageNumber(part, 'cost'));
    }
    return {};
  }
  const item = value.item && typeof value.item === 'object' ? (value.item as Record<string, unknown>) : {};
  const itemType = typeof item.type === 'string' ? item.type : '';
  if (type === 'item.completed' && itemType === 'agent_message') {
    const text = textOf(item.text ?? item.content);
    const bytes = Buffer.byteLength(text);
    if (output.bytes + bytes > MAX_OUTPUT_BYTES) throw new CodingExecError('Codex output exceeded the limit', 'coding_oversized');
    output.bytes += bytes;
    if (text) output.text += `${output.text ? '\n' : ''}${text}`;
    addEvent(events, 'text', text, sink, transcript);
  } else if ((type === 'item.started' || type === 'item.updated') && itemType === 'agent_message') {
    addEvent(events, 'text', textOf(item.text ?? item.content), sink, transcript);
  } else if (type === 'item.started' || type === 'item.updated' || type === 'item.completed') {
    if (itemType === 'reasoning' || itemType === 'reasoning_summary') {
      addEvent(events, 'thinking', textOf(item.text ?? item.summary ?? item.content), sink, transcript);
    } else if (itemType && itemType !== 'agent_message') {
      const label = textOf(item.name ?? item.command ?? item.text);
      addEvent(events, 'tool', `${itemType}${label ? `: ${label}` : ''}`, sink, transcript);
    }
  } else if (type === 'turn.completed') {
    const u = (value.usage && typeof value.usage === 'object' ? value.usage : value) as Record<string, unknown>;
    usage.inputTokens = usageNumber(u, 'input_tokens');
    usage.cachedInputTokens = usageNumber(u, 'cached_input_tokens');
    usage.outputTokens = usageNumber(u, 'output_tokens');
    usage.reasoningTokens = usageNumber(u, 'reasoning_output_tokens');
  } else if (type === 'turn.failed' || type === 'error') {
    const message = textOf(value.error ?? value.message ?? value.detail) || 'Codex reported an error';
    addEvent(events, 'error', redact(message), sink, transcript);
    return { failed: redact(message) };
  }
  return {};
};

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
    if (error) reject(error);
    else resolve({ output: output.text, usage, events, sessionId: null });
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
    if (sandboxContext && runDir) await sandbox.syncCredentials(sandboxContext, runDir, config.cli).catch((error) => console.error(error));
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
