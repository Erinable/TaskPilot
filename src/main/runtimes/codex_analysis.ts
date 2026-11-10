import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { AgentRunError } from './claude_cli.ts';
import type { RunStructuredOptions, StructuredResult } from './claude_cli.ts';
import { processEnv } from '../infrastructure/env.ts';
import { logger } from '../infrastructure/logger.ts';
import { assertCodexHostConfig } from './codex_host_config.ts';
import { prepareCodexProfile } from './codex_profile.ts';
import { codexAnalysisArgs } from './codex_config.ts';
import { writeCodexCatalog } from './codex_catalog.ts';
import { assertAnalysisEvent, parseCodexAnalysisOutput } from './structured_output.ts';
import { codexCall } from './model_usage.ts';
import type { AgentRuntimeConfig } from '../../shared/agent_runtime.ts';

const MAX_OUTPUT = 4 * 1024 * 1024;
const MAX_STDERR = 16 * 1024;
const redact = (value: string) => value.replace(/(api[_ -]?key|token|password|secret)(\s*[:=]\s*)\S+/gi, '$1$2[redacted]');
type Profile = Awaited<ReturnType<typeof prepareCodexProfile>>;
type Dependencies = { prepare?: (root: string) => Promise<Omit<Profile, 'syncCredentials'> & { syncCredentials?: () => Promise<void> }> };

export const runCodexAnalysis = async (options: RunStructuredOptions, config: AgentRuntimeConfig, deps: Dependencies = {}): Promise<StructuredResult> => {
  if (options.signal?.aborted) throw new AgentRunError('Codex analysis was cancelled', 'agent_cancelled');
  await assertCodexHostConfig();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskpilot-codex-analysis-'));
  await fs.chmod(root, 0o700);
  try {
    const profile = await (deps.prepare ?? prepareCodexProfile)(root);
    const model = config.model || options.model || profile.model;
    if (!model) throw new AgentRunError('Codex 尚无默认模型或本地模型缓存。请在「模型与智能体」为该角色填写模型 ID。', 'agent_unavailable');
    const cwd = path.join(root, 'work');
    const home = path.join(root, 'home');
    const temporary = path.join(root, 'tmp');
    await Promise.all([cwd, home, temporary].map((directory) => fs.mkdir(directory, { mode: 0o700 })));
    const schema = path.join(root, 'schema.json');
    const instructions = path.join(root, 'instructions.md');
    await fs.writeFile(schema, JSON.stringify(options.schema), { mode: 0o600 });
    await fs.writeFile(
      instructions,
      `${options.systemPrompt}\n\nUse only the supplied task data. Do not call tools, inspect files, run commands or browse. Return exactly the JSON object required by the response schema.`,
      { mode: 0o600 },
    );
    const metadata = profile.metadata.find((entry) => entry.slug === model);
    const catalog = await writeCodexCatalog(root, model, metadata);
    const effectiveConfig = { ...config, thinking: config.thinking === 'default' ? (profile.thinking ?? 'default') : config.thinking };
    const args = codexAnalysisArgs(effectiveConfig, { cwd, schema, instructions, catalog, model });
    const source = processEnv();
    const environment: NodeJS.ProcessEnv = {
      PATH: options.envPath ?? source.PATH,
      HOME: home,
      CODEX_HOME: profile.directory,
      XDG_CONFIG_HOME: path.join(home, '.config'),
      XDG_DATA_HOME: path.join(home, '.local', 'share'),
      XDG_CACHE_HOME: path.join(home, '.cache'),
      TMPDIR: temporary,
      NO_COLOR: '1',
      TERM: 'dumb',
      ...profile.environment,
    };
    for (const key of [
      'LANG',
      'LC_ALL',
      'HTTPS_PROXY',
      'HTTP_PROXY',
      'ALL_PROXY',
      'NO_PROXY',
      'https_proxy',
      'http_proxy',
      'all_proxy',
      'no_proxy',
      'SSL_CERT_FILE',
      'SSL_CERT_DIR',
    ])
      if (source[key]) environment[key] = source[key];
    try {
      return await executeCodex(options, args, cwd, environment, model, profile.provider);
    } finally {
      await profile.syncCredentials?.().catch((error) => logger.error('[codex] could not persist refreshed credentials', error));
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
};

const executeCodex = (
  options: RunStructuredOptions,
  args: string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  model: string,
  provider: string,
): Promise<StructuredResult> =>
  new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = (options.spawnFn ?? spawn)(options.command ?? 'codex', args, {
        cwd,
        env: environment,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
    } catch (error) {
      reject(new AgentRunError('Could not start Codex analysis', 'agent_unavailable', redact(String(error))));
      return;
    }
    let stdout = '';
    let stderr = '';
    let pendingLine = '';
    let failure: AgentRunError | null = null;
    let done = false;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const call = () => ({ ...codexCall(stdout, model), provider: provider === 'openai' ? 'openai' : provider });
    const signal = (kind: NodeJS.Signals) => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, kind);
        else child.kill(kind);
      } catch {
        child.kill(kind);
      }
    };
    const stop = (error: AgentRunError) => {
      if (failure || done) return;
      failure = error;
      child.stdin.destroy();
      signal('SIGTERM');
      escalation = setTimeout(() => signal('SIGKILL'), 250);
      escalation.unref?.();
    };
    const finish = (error: AgentRunError | null, result?: StructuredResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(escalation);
      options.signal?.removeEventListener('abort', abort);
      if (error) {
        const spent = call();
        if (spent.tokens) error.call = spent;
        reject(error);
      } else if (result) resolve(result);
    };
    const abort = () => stop(new AgentRunError('Codex analysis was cancelled', 'agent_cancelled'));
    const timer = setTimeout(() => stop(new AgentRunError('Codex analysis timed out', 'agent_timeout')), options.timeoutMs ?? 3 * 60 * 1000);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string | Buffer) => {
      if (failure || done) return;
      const text = chunk.toString();
      if (Buffer.byteLength(stdout) + Buffer.byteLength(text) > MAX_OUTPUT) {
        stop(new AgentRunError('Codex output exceeded the limit', 'agent_bad_output'));
        return;
      }
      stdout += text;
      const lines = (pendingLine + text).split(/\r?\n/);
      pendingLine = lines.pop() ?? '';
      try {
        for (const line of lines) if (line.trim()) assertAnalysisEvent(JSON.parse(line), 'codex');
      } catch (error) {
        stop(error instanceof AgentRunError ? error : new AgentRunError('Codex emitted invalid JSONL', 'agent_bad_output'));
      }
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      if (stderr.length < MAX_STDERR) stderr += chunk.toString().slice(0, MAX_STDERR - stderr.length);
    });
    child.on('error', (error: NodeJS.ErrnoException) =>
      finish(
        new AgentRunError(
          error.code === 'ENOENT' ? 'Codex executable or its runtime was not found' : 'Could not run Codex analysis',
          'agent_unavailable',
          redact(error.message),
        ),
      ),
    );
    child.on('close', (code: number | null) => {
      if (failure) return finish(failure);
      if (code !== 0) return finish(new AgentRunError(`Codex analysis exited with ${code}`, 'agent_failed', redact(stderr.slice(-2000))));
      try {
        const output = parseCodexAnalysisOutput(stdout);
        finish(null, { output, costUsd: null, call: call() });
      } catch (error) {
        finish(error instanceof AgentRunError ? error : new AgentRunError('Could not parse Codex analysis output', 'agent_bad_output'));
      }
    });
    child.stdin.on('error', () => {});
    if (!failure) child.stdin.end(options.prompt);
  });
