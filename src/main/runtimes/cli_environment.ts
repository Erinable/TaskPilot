import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';

import { CLI_OPTIONS } from '../../shared/agent_runtime.ts';
import type { AgentRuntimeConfig } from '../../shared/agent_runtime.ts';
import { processEnv } from '../infrastructure/env.ts';
import { AgentRunError } from './claude_cli.ts';
import type { RunStructuredOptions } from './claude_cli.ts';
import { loadNativeModelProfile } from './native_model_profile.ts';

export type CliProbeResult = { command: string; available: boolean; version: string | null; reason: string | null };
type Cli = AgentRuntimeConfig['cli'];
const GROK_AUTH_ENV = ['XAI_API_KEY'];

export const commandFor = (cli: Cli): string => ({ claude: 'claude', pi: 'pi', grok: 'grok', codex: 'codex', opencode: 'opencode' })[cli];

export const envFor = (cli: Cli, cwd: string, envPath?: string | null, nativeAuth: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => {
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

export const copyAuthFile = async (cli: Cli, cwd: string): Promise<void> => {
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

export const hasGrokAuth = async (nativeConfigured = false): Promise<boolean> => {
  const source = processEnv();
  if (nativeConfigured || source.XAI_API_KEY) return true;
  try {
    await fs.access(path.join(source.HOME ?? os.homedir(), '.grok', 'auth.json'));
    return true;
  } catch {
    return false;
  }
};

export const ensureConfig = (config: AgentRuntimeConfig): void => {
  const capability = config && CLI_OPTIONS.find((entry) => entry.id === config.cli);
  if (!capability) throw new AgentRunError('Unsupported agent CLI configuration', 'agent_unavailable');
  if (!capability.analysis) throw new AgentRunError('Codex CLI lacks a verified no-tools analysis mode; select it only for Coding Agent', 'agent_unavailable');
  if (!capability.thinking.includes(config.thinking))
    throw new AgentRunError(`Unsupported ${config.cli} thinking level: ${config.thinking}`, 'agent_unavailable');
};

export const argsFor = (options: RunStructuredOptions, config: AgentRuntimeConfig): string[] => {
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

export const redact = (text: string): string => text.replace(/(api[_ -]?key|token|password|secret)(\s*[:=]\s*)\S+/gi, '$1$2[redacted]');
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
