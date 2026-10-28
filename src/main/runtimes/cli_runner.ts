import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { AgentRuntimeConfig } from '../../shared/agent_runtime.ts';
import { AgentRunError, runStructured as runClaude } from './claude_cli.ts';
import type { RunStructuredOptions, SpawnFn, StructuredResult } from './claude_cli.ts';
import { streamCall } from './model_usage.ts';
import { loadNativeModelProfile, nativeClaudeInferenceEnv, nativeInferenceDefaults } from './native_model_profile.ts';
import { argsFor, commandFor, copyAuthFile, ensureConfig, envFor, hasGrokAuth, probeCli, redact } from './cli_environment.ts';
import { assertAnalysisEvent, parseStructuredOutput } from './structured_output.ts';

const MAX_OUTPUT = 4 * 1024 * 1024;
const MAX_STDERR = 16 * 1024;
const TIMEOUT = 3 * 60 * 1000;

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
