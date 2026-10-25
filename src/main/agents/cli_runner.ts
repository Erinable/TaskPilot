import { spawn } from 'node:child_process';
import type { ChildProcessByStdio, ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';

import { CLI_OPTIONS } from '../../shared/agent_runtime.ts';
import type { AgentRuntimeConfig } from '../../shared/agent_runtime.ts';
import { processEnv } from '../env.ts';
import { AgentRunError, runStructured as runClaude } from './claude_cli.ts';
import type { RunStructuredOptions, SpawnFn, StructuredResult } from './claude_cli.ts';
import { isObject } from './product_lead.ts';
import { streamCall } from './model_usage.ts';

import { loadNativeModelProfile, nativeClaudeInferenceEnv, nativeInferenceDefaults } from './native_model_profile.ts';
export type CliProbeResult = { command: string; available: boolean; version: string | null; reason: string | null };
const MAX_OUTPUT = 4 * 1024 * 1024;
const MAX_STDERR = 16 * 1024;
const TIMEOUT = 3 * 60 * 1000;
const GROK_AUTH_ENV = ['XAI_API_KEY'];
type Cli = AgentRuntimeConfig['cli'];

const commandFor = (cli: Cli): string => ({ claude: 'claude', pi: 'pi', grok: 'grok', codex: 'codex', opencode: 'opencode' })[cli];

const envFor = (cli: Cli, cwd: string, envPath?: string | null, nativeAuth: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => {
  const source = processEnv();
  const env: NodeJS.ProcessEnv = { PATH: envPath || source.PATH, HOME: cwd, NO_COLOR: '1', TERM: 'dumb' };
  // Inherit only explicit provider authentication / endpoint variables. The
  // authentication JSON files are copied separately without user resources.
  const auth =
    cli === 'claude'
      ? ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']
      : cli === 'pi'
        ? [
            'ANTHROPIC_API_KEY',
            'OPENAI_API_KEY',
            'GOOGLE_API_KEY',
            'GEMINI_API_KEY',
            'OPENROUTER_API_KEY',
            'XAI_API_KEY',
            'GROQ_API_KEY',
            'MISTRAL_API_KEY',
            'DEEPSEEK_API_KEY',
            'COHERE_API_KEY',
            'TOGETHER_API_KEY',
            'FIREWORKS_API_KEY',
            'PERPLEXITY_API_KEY',
            'DEEPINFRA_API_KEY',
          ]
        : cli === 'grok'
          ? GROK_AUTH_ENV
          : cli === 'codex'
            ? ['OPENAI_API_KEY']
            : [
                'ANTHROPIC_API_KEY',
                'OPENAI_API_KEY',
                'GOOGLE_API_KEY',
                'GEMINI_API_KEY',
                'OPENROUTER_API_KEY',
                'XAI_API_KEY',
                'GROQ_API_KEY',
                'MISTRAL_API_KEY',
                'DEEPSEEK_API_KEY',
                'COHERE_API_KEY',
                'TOGETHER_API_KEY',
                'FIREWORKS_API_KEY',
                'PERPLEXITY_API_KEY',
                'DEEPINFRA_API_KEY',
              ];
  for (const key of auth) if (source[key]) env[key] = source[key];
  for (const [key, value] of Object.entries(nativeAuth)) if (value) env[key] = value;
  env.PI_CODING_AGENT_DIR = path.join(cwd, 'pi');
  env.GROK_HOME = path.join(cwd, 'grok');
  for (const key of [
    'OPENAI_BASE_URL',
    'ANTHROPIC_BASE_URL',
    'GOOGLE_GEMINI_BASE_URL',
    'GROK_CLI_CHAT_PROXY_BASE_URL',
    'GROK_MODELS_BASE_URL',
    'GROK_MODELS_LIST_URL',
  ])
    if (source[key]) env[key] = source[key];
  env.OPENCODE_CONFIG_DIR = path.join(cwd, 'opencode', 'config');
  env.OPENCODE_DISABLE_DEFAULT_PLUGINS = '1';
  env.OPENCODE_PERMISSION = JSON.stringify('deny');
  env.XDG_CONFIG_HOME = path.join(cwd, 'xdg-config');
  env.XDG_DATA_HOME = path.join(cwd, 'xdg-data');
  env.XDG_STATE_HOME = path.join(cwd, 'xdg-state');
  env.XDG_CACHE_HOME = path.join(cwd, 'xdg-cache');
  return env;
};

const copyAuthFile = async (cli: Cli, cwd: string): Promise<void> => {
  const home = processEnv().HOME ?? os.homedir();
  const source =
    cli === 'pi'
      ? path.join(home, '.pi', 'agent', 'auth.json')
      : cli === 'opencode'
        ? path.join(home, '.local', 'share', 'opencode', 'auth.json')
        : cli === 'grok'
          ? path.join(home, '.grok', 'auth.json')
          : null;
  if (!source) return;
  const destination =
    cli === 'pi'
      ? path.join(cwd, 'pi', 'auth.json')
      : cli === 'opencode'
        ? path.join(cwd, 'xdg-data', 'opencode', 'auth.json')
        : path.join(cwd, 'grok', 'auth.json');
  try {
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await fs.copyFile(source, destination);
    await fs.chmod(destination, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
};

const hasGrokAuth = async (nativeConfigured = false): Promise<boolean> => {
  const source = processEnv();
  if (nativeConfigured || source.XAI_API_KEY) return true;
  try {
    await fs.access(path.join(source.HOME ?? os.homedir(), '.grok', 'auth.json'));
    return true;
  } catch {
    return false;
  }
};

const ensureConfig = (config: AgentRuntimeConfig): void => {
  const capability = config && CLI_OPTIONS.find((entry) => entry.id === config.cli);
  if (!capability) throw new AgentRunError('Unsupported agent CLI configuration', 'agent_unavailable');
  if (!capability.analysis) throw new AgentRunError('Codex CLI lacks a verified no-tools analysis mode; select it only for Coding Agent', 'agent_unavailable');
  if (!capability.thinking.includes(config.thinking))
    throw new AgentRunError(`Unsupported ${config.cli} thinking level: ${config.thinking}`, 'agent_unavailable');
};

const argsFor = (options: RunStructuredOptions, config: AgentRuntimeConfig): string[] => {
  const args: string[] = [];
  const model = config.model || options.model || '';
  switch (config.cli) {
    case 'pi':
      args.push(
        '--mode',
        'json',
        '--print',
        '--no-tools',
        '--no-extensions',
        '--no-mcp',
        '--no-skills',
        '--no-prompt-templates',
        '--no-context-files',
        '--no-session',
      );
      if (model) args.push('--model', model);
      if (config.thinking !== 'default') args.push('--thinking', config.thinking);
      break;
    case 'grok':
      args.push(
        '--system-prompt-override',
        options.systemPrompt,
        '--output-format',
        'streaming-messages-json',
        '--tools',
        '',
        '--deny',
        'MCPTool',
        '--disable-web-search',
        '--no-subagents',
        '--prompt-file',
        path.join(process.cwd(), 'UNUSED'),
      );
      if (model) args.push('--model', model);
      if (config.thinking !== 'default') args.push('--reasoning-effort', config.thinking);
      break;
    case 'opencode':
      args.push('run', '--pure', '--format', 'json');
      if (model) args.push('--model', model);
      if (config.thinking !== 'default') args.push('--variant', config.thinking);
      break;
    case 'codex':
      throw new AgentRunError('Codex analysis is unavailable: Codex CLI does not provide a verified no-tools mode', 'agent_unavailable');
    case 'claude':
      break;
  }
  return args;
};

const hasToolContent = (content: unknown) =>
  Array.isArray(content) && content.some((part) => isObject(part) && (part.type === 'tool_use' || part.type === 'tool_call'));
const initializesAnalysis = (type: string, event: Record<string, unknown>) =>
  type === 'init' || type === 'step_start' || (type === 'system' && event.subtype === 'init');
const hasTools = (tools: unknown) => (Array.isArray(tools) && tools.length > 0) || (isObject(tools) && Object.keys(tools).length > 0);
const isJsonRecord = (value: unknown): value is Record<string, unknown> => isObject(value) && !Array.isArray(value);

const assertAnalysisEvent = (event: unknown): void => {
  if (!isObject(event) || Array.isArray(event)) return;
  const type = typeof event.type === 'string' ? event.type : '';
  const message = isObject(event.message) ? event.message : event;
  if (type === 'error' || event.is_error === true || message.stopReason === 'error' || (typeof event.subtype === 'string' && event.subtype.startsWith('error')))
    throw new AgentRunError('Agent CLI reported a failed turn', 'agent_failed');
  if (initializesAnalysis(type, event) && hasTools(event.tools))
    throw new AgentRunError('CLI initialized tools in isolated analysis mode', 'agent_unavailable');
  if (type === 'tool' || type === 'tool_execution_start' || type === 'tool_execution_end')
    throw new AgentRunError('CLI attempted a tool in isolated analysis mode', 'agent_unavailable');
  if (hasToolContent(message.content)) throw new AgentRunError('CLI attempted a tool in isolated analysis mode', 'agent_unavailable');
};

const assistantText = (message: Record<string, unknown>): string[] => {
  if (typeof message.role === 'string' && message.role !== 'assistant') return [];
  const content = message.content;
  if (typeof content === 'string') return [content];
  const parts: string[] = [];
  if (!Array.isArray(content)) return parts;
  for (const part of content) {
    if (!isObject(part) || Array.isArray(part)) continue;
    if (part.type === 'tool_use' || part.type === 'tool_call') throw new AgentRunError('CLI attempted a tool in isolated analysis mode', 'agent_unavailable');
    if (part.type === 'text' && typeof part.text === 'string') parts.push(part.text);
  }
  return parts;
};

const structuredResult = (structured: unknown, result: unknown, assistant: string[], rawObject: Record<string, unknown> | null): unknown => {
  if (isObject(structured) && !Array.isArray(structured)) return structured;
  if (isObject(result) && !Array.isArray(result)) return result;
  const text = typeof result === 'string' ? result : assistant.join('\n').trim();
  if (text) {
    try {
      const value: unknown = JSON.parse(text);
      if (isObject(value) && !Array.isArray(value)) return value;
    } catch {
      throw new AgentRunError('Agent did not return structured JSON output', 'agent_bad_output');
    }
  }
  if (rawObject) return rawObject;
  throw new AgentRunError('Agent did not return structured JSON output', 'agent_bad_output');
};

export const parseStructuredOutput = (input: string): unknown => {
  const assistant: string[] = [];
  let structured: unknown;
  let result: unknown;
  let rawObject: Record<string, unknown> | null = null;
  for (const line of input.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new AgentRunError('Agent emitted invalid JSONL', 'agent_bad_output');
    }
    if (!isJsonRecord(parsed)) continue;
    const event = parsed;
    const type = typeof event.type === 'string' ? event.type : '';
    const message = isJsonRecord(event.message) ? event.message : event;
    assertAnalysisEvent(event);
    if (isJsonRecord(event.structured_output)) structured = event.structured_output;
    if (type === 'result' || (!type && 'result' in event)) result = event.result;
    if (!type && !('result' in event) && !('structured_output' in event)) rawObject = event;
    if (['message_end', 'assistant', 'message'].includes(type)) {
      assistant.push(...assistantText(message));
    }
    if (type === 'text') {
      if (isObject(event.part) && typeof event.part.text === 'string') assistant.push(event.part.text);
      else if (typeof event.text === 'string') assistant.push(event.text);
    }
  }
  // Validate the entire stream before accepting a success: a later terminal
  // failure or tool event must not be hidden by an earlier JSON result.
  return structuredResult(structured, result, assistant, rawObject);
};
const runProcess = async (options: RunStructuredOptions, config: AgentRuntimeConfig): Promise<StructuredResult> => {
  if (options.signal?.aborted) throw new AgentRunError('Agent run was cancelled', 'agent_cancelled');
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'taskpilot-agent-'));
  try {
    const profile = await loadNativeModelProfile(config.cli, cwd);
    const resolved = nativeInferenceDefaults(profile, config.model || options.model || '', config.thinking);
    if (config.cli === 'grok' && !(await hasGrokAuth(profile.grokConfiguredApiKey)))
      throw new AgentRunError('Grok isolated analysis requires XAI_API_KEY, a native model credential, or ~/.grok/auth.json', 'agent_unavailable');
    await copyAuthFile(config.cli, cwd);
    const effectiveConfig = { ...config, model: resolved.model };
    const args = argsFor(options, effectiveConfig);
    let prompt = `${options.systemPrompt}\n\nReturn exactly one JSON object matching this JSON Schema (the caller validates it):\n${JSON.stringify(options.schema)}\n\n${options.prompt}`;
    if (config.cli === 'grok') {
      args[args.indexOf('--prompt-file') + 1] = path.join(cwd, 'prompt.txt');
      await fs.writeFile(args[args.indexOf('--prompt-file') + 1], prompt, { mode: 0o600 });
      prompt = '';
    }
    const spawnFn: SpawnFn = options.spawnFn ?? spawn;
    const command = options.command ?? commandFor(config.cli);
    const { promise, resolve, reject } = Promise.withResolvers<StructuredResult>();
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnFn(command, args, {
        cwd,
        env: envFor(config.cli, cwd, options.envPath, profile.grokEnvironment),
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
    } catch (error) {
      reject(new AgentRunError(`Could not start ${command}`, 'agent_unavailable', redact(String(error))));
      return await promise;
    }
    let stdout = '';
    let stderr = '';
    let done = false;
    let cause: 'timeout' | 'cancelled' | 'large' | null = null;
    let protocolFailure: AgentRunError | null = null;
    let pendingLine = '';
    let escalation: NodeJS.Timeout | undefined;
    const settle = (error: AgentRunError | null, result?: StructuredResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(escalation);
      options.signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else if (result) resolve(result);
    };
    const stop = (why: 'timeout' | 'cancelled' | 'large') => {
      if (cause) return;
      cause = why;
      child.stdin.destroy();
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM');
        else child.kill('SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
      escalation = setTimeout(() => {
        try {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }, 250);
      escalation.unref?.();
    };
    const abort = () => stop('cancelled');
    const timer = setTimeout(() => stop('timeout'), options.timeoutMs ?? TIMEOUT);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: Buffer | string) => {
      if (cause) return;
      const text = chunk.toString();
      stdout += text;
      if (Buffer.byteLength(stdout) > MAX_OUTPUT) {
        stop('large');
        return;
      }
      const lines = (pendingLine + text).split('\n');
      pendingLine = lines.pop() ?? '';
      try {
        for (const line of lines) if (line.trim()) assertAnalysisEvent(JSON.parse(line));
      } catch (error) {
        protocolFailure = error instanceof AgentRunError ? error : new AgentRunError('Agent emitted invalid JSONL', 'agent_bad_output');
        stop('large');
      }
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      if (stderr.length < MAX_STDERR) stderr += chunk.toString().slice(0, MAX_STDERR - stderr.length);
    });
    child.on('error', (error: NodeJS.ErrnoException) =>
      settle(new AgentRunError(error.code === 'ENOENT' ? `${command} CLI not found` : `Could not run ${command}`, 'agent_unavailable', redact(error.message))),
    );
    child.on('close', (code: number | null) => {
      if (protocolFailure) return settle(protocolFailure);
      if (cause === 'timeout') return settle(new AgentRunError('Agent did not finish in time', 'agent_timeout'));
      if (cause === 'cancelled') return settle(new AgentRunError('Agent run was cancelled', 'agent_cancelled'));
      if (cause === 'large') return settle(new AgentRunError('Agent output was too large', 'agent_bad_output'));
      if (code !== 0) return settle(new AgentRunError(`Agent CLI exited with ${code}`, 'agent_failed', redact(stderr.slice(-2000))));
      try {
        const output = parseStructuredOutput(stdout);
        // Claude goes through claude_cli.ts; Codex has no analysis mode.
        const call = config.cli === 'claude' || config.cli === 'codex' ? undefined : streamCall(config.cli, stdout);
        settle(null, { output, costUsd: call?.costUsd ?? null, call });
      } catch (error) {
        settle(error instanceof AgentRunError ? error : new AgentRunError('Could not parse CLI output', 'agent_bad_output'));
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
    return await promise;
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
};

const redact = (text: string): string => text.replace(/(api[_ -]?key|token|password|secret)(\s*[:=]\s*)\S+/gi, '$1$2[redacted]');
const runProbeCommand = async (command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> => {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  let child: ChildProcessByStdio<null, Readable, Readable>;
  try {
    child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  } catch (error) {
    reject(error);
    return promise;
  }
  let output = '';
  let settled = false;
  const finish = (error?: Error, value?: string) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (error) reject(error);
    else resolve(value ?? '');
  };
  const stop = () => {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM');
      else child.kill('SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
    finish(new Error(`Timed out running ${command} ${args[0]}`));
  };
  const timer = setTimeout(stop, 10_000);
  child.stdout.on('data', (chunk: Buffer | string) => {
    output += chunk.toString();
    if (Buffer.byteLength(output) > 64 * 1024) {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM');
        else child.kill('SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
      finish(new Error(`${command} ${args[0]} output exceeded the limit`));
    }
  });
  child.stderr.on('data', (chunk: Buffer | string) => {
    if (output.length < 64 * 1024) output += chunk.toString().slice(0, 64 * 1024 - output.length);
  });
  child.on('error', (error: Error) => finish(error));
  child.on('close', (code: number | null) => (code === 0 ? finish(undefined, output) : finish(new Error(`${command} ${args[0]} failed with ${code}`))));
  return promise;
};

export const runStructured = async (options: RunStructuredOptions, config: AgentRuntimeConfig): Promise<StructuredResult> => {
  ensureConfig(config);
  if (config.cli === 'opencode') {
    const status = await probeCli(config, options.envPath);
    if (!status.available) throw new AgentRunError(status.reason ?? 'OpenCode CLI is unavailable for isolated analysis', 'agent_unavailable');
  }
  if (config.cli === 'codex')
    throw new AgentRunError('Codex analysis is unavailable: Codex CLI does not provide a verified no-tools mode', 'agent_unavailable');
  if (config.cli === 'claude') {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'taskpilot-claude-config-'));
    try {
      const profile = await loadNativeModelProfile(config.cli, cwd);
      const resolved = nativeInferenceDefaults(profile, config.model || options.model || '', config.thinking);
      return await runClaude({
        ...options,
        model: resolved.model || null,
        thinking: config.thinking,
        inferenceEnv: nativeClaudeInferenceEnv(profile, config.thinking),
      });
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  }
  return runProcess(options, config);
};
export const probeCli = async (config: AgentRuntimeConfig, envPath?: string | null): Promise<CliProbeResult> => {
  const command = commandFor(config.cli);
  try {
    ensureConfig(config);
  } catch (error) {
    return { command, available: false, version: null, reason: (error as Error).message };
  }
  if (config.cli === 'codex')
    return { command, available: false, version: null, reason: 'Codex analysis is unavailable: Codex CLI lacks a verified no-tools mode' };
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'taskpilot-probe-'));
  try {
    const profile = await loadNativeModelProfile(config.cli, cwd);
    if (config.cli === 'grok' && !(await hasGrokAuth(profile.grokConfiguredApiKey)))
      return {
        command,
        available: false,
        version: null,
        reason: 'Grok isolated analysis requires XAI_API_KEY, a native model credential, or ~/.grok/auth.json',
      };
    const env = envFor(config.cli, cwd, envPath, profile.grokEnvironment);
    const versionOutput = await runProbeCommand(command, ['--version'], cwd, env);
    const version = versionOutput.trim().split(/\r?\n/)[0] ?? '';
    const helpArgs = config.cli === 'opencode' ? ['run', '--help'] : ['--help'];
    const help = await runProbeCommand(command, helpArgs, cwd, env);
    const required =
      config.cli === 'claude'
        ? ['--tools', '--restricted', '--strict-mcp-config', '--json-schema']
        : config.cli === 'pi'
          ? ['--mode', '--no-tools', '--no-extensions', '--no-mcp', '--no-session']
          : config.cli === 'grok'
            ? ['--tools', '--deny', '--prompt-file', '--system-prompt-override', '--no-subagents', '--output-format']
            : ['--pure', '--format', '--model'];
    const missing = required.filter((flag) => !help.includes(flag));
    if (missing.length)
      return {
        command,
        available: false,
        version: version || null,
        reason: `${config.cli} CLI lacks required isolated-mode capability: ${missing.join(', ')}`,
      };
    if (config.cli === 'opencode' && !/\b1\./.test(version))
      return { command, available: false, version: version || null, reason: 'Restricted analysis requires OpenCode version 1.x' };
    return { command, available: true, version: version || null, reason: null };
  } catch (error) {
    return { command, available: false, version: null, reason: redact((error as Error).message) };
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
};
