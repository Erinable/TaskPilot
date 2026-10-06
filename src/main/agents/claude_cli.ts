// Runs one structured agent turn through the Claude Code CLI in headless mode.
//
// The CLI is started as an isolated, tool-less process:
//   --tools ""            no built-in tools: it cannot read files or run commands
//   --restricted          ignores user/project/local settings, CLAUDE.md, hooks
//   --strict-mcp-config   no MCP servers
//   --no-session-persistence  nothing written to ~/.claude/projects
//   --json-schema         structured output, validated again by the caller
//   --max-budget-usd      a hard per-call spending cap
// It runs in an empty temporary directory, and Claude Code's own session
// variables are removed from its environment so it never attaches to, or
// inherits identity from, a parent Claude Code session.
//
// The prompt goes in on stdin, never on the command line, so requirement text
// can't be read back from the process list or parsed as a flag.
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { processEnv } from '../env.ts';

export type JsonSchema = Record<string, unknown>;

export type SpawnFn = (command: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;

export interface RunStructuredOptions {
  // User turn, sent on stdin.
  prompt: string;
  systemPrompt: string;
  // JSON Schema for the structured output.
  schema: JsonSchema;
  // CLI executable (default 'claude').
  command?: string;
  model?: string | null;
  // PATH to launch with (see ../shell_env.ts).
  envPath?: string | null;
  budgetUsd?: number;
  timeoutMs?: number;
  // Cancels the run.
  signal?: AbortSignal;
  // Injectable for tests.
  spawnFn?: SpawnFn;
}

// Structured output is validated by each agent, so it stays untyped here.
export interface StructuredResult {
  output: unknown;
  costUsd: number | null;
}

export type RunAgent = (options: RunStructuredOptions) => Promise<StructuredResult>;

export type AgentErrorCode =
  | 'agent_bad_output' | 'agent_budget' | 'agent_schema_retry' | 'agent_failed'
  | 'agent_cancelled' | 'agent_unavailable' | 'agent_timeout';

interface Envelope {
  is_error?: boolean;
  subtype?: string;
  result?: unknown;
  structured_output?: unknown;
  total_cost_usd?: unknown;
}

const DEFAULT_TIMEOUT_MS = 3 * 60 * 1000;
export const DEFAULT_BUDGET_USD = 1;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export class AgentRunError extends Error {
  code: AgentErrorCode;
  detail?: string;

  constructor(message: string, code: AgentErrorCode, detail?: string) {
    super(message);
    this.name = 'AgentRunError';
    this.code = code;
    if (detail) this.detail = detail;
  }
}

// Environment for the child: the parent's, minus Claude Code session state.
export const childEnv = (base: NodeJS.ProcessEnv, envPath?: string | null): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_') || key === 'CLAUDE_PID' || key === 'CLAUDE_EFFORT') continue;
    env[key] = value;
  }
  if (envPath) env.PATH = envPath;
  env.NO_COLOR = '1';
  return env;
};

export const cliArgs = ({ systemPrompt, schema, model, budgetUsd }: {
  systemPrompt: string;
  schema: JsonSchema;
  model?: string | null;
  budgetUsd: number;
}): string[] => {
  const args = [
    '-p',
    '--output-format', 'json',
    '--tools', '',
    '--restricted',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--max-budget-usd', String(budgetUsd),
    '--system-prompt', systemPrompt,
    '--json-schema', JSON.stringify(schema),
  ];
  if (model) args.push('--model', model);
  return args;
};

// Pulls the structured result out of the CLI's JSON envelope.
export const parseEnvelope = (stdout: string): StructuredResult => {
  let envelope: Envelope;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    throw new AgentRunError('Agent returned output that is not JSON', 'agent_bad_output', stdout.slice(0, 500));
  }
  if (envelope.is_error || envelope.subtype !== 'success') {
    const reason = envelope.subtype === 'error_max_budget_usd' ? 'agent_budget'
      // The CLI gave up after its own schema-repair attempts; worth one fresh try.
      : envelope.subtype === 'error_max_structured_output_retries' ? 'agent_schema_retry'
      : 'agent_failed';
    throw new AgentRunError(String(envelope.result || `Agent run ended with ${envelope.subtype}`), reason);
  }
  let output = envelope.structured_output;
  if (output === undefined && typeof envelope.result === 'string') {
    try {
      output = JSON.parse(envelope.result);
    } catch {
      throw new AgentRunError('Agent did not return structured output', 'agent_bad_output', envelope.result.slice(0, 500));
    }
  }
  if (!output || typeof output !== 'object') throw new AgentRunError('Agent did not return structured output', 'agent_bad_output');
  return { output, costUsd: typeof envelope.total_cost_usd === 'number' ? envelope.total_cost_usd : null };
};

const codeOf = (error: unknown): unknown => (error as { code?: unknown } | null)?.code;

// One CLI run; see RunStructuredOptions.
const runOnce = async ({
  prompt, systemPrompt, schema, command = 'claude', model = null, envPath = null,
  budgetUsd = DEFAULT_BUDGET_USD, timeoutMs = DEFAULT_TIMEOUT_MS, signal, spawnFn = spawn,
}: RunStructuredOptions): Promise<StructuredResult> => {
  if (signal?.aborted) throw new AgentRunError('Agent run was cancelled', 'agent_cancelled');
  // An empty working directory: with no tools there is nothing to read, and
  // the CLI won't discover a project CLAUDE.md from it either.
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'taskpilot-agent-'));
  try {
    return await new Promise<StructuredResult>((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawnFn(command, cliArgs({ systemPrompt, schema, model, budgetUsd }), {
          cwd, env: childEnv(processEnv(), envPath), stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (error) {
        reject(new AgentRunError(`Could not start ${command}: ${(error as Error).message}`, 'agent_unavailable'));
        return;
      }

      let stdout = '';
      let stderr = '';
      let settled = false;
      let reason: 'timeout' | 'cancelled' | 'too_large' | null = null;
      const finish = <T>(fn: (value: T) => void, value: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        fn(value);
      };
      const stop = (why: 'timeout' | 'cancelled' | 'too_large') => {
        reason = why;
        child.kill('SIGTERM');
      };
      const timer = setTimeout(() => stop('timeout'), timeoutMs);
      const onAbort = () => stop('cancelled');
      signal?.addEventListener('abort', onAbort, { once: true });

      child.stdout.on('data', (chunk: Buffer | string) => {
        stdout += chunk;
        if (stdout.length > MAX_OUTPUT_BYTES) stop('too_large');
      });
      child.stderr.on('data', (chunk: Buffer | string) => {
        if (stderr.length < 64 * 1024) stderr += chunk;
      });
      child.on('error', (error: NodeJS.ErrnoException) => {
        finish(reject, error.code === 'ENOENT'
          ? new AgentRunError(`Claude Code CLI not found: ${command}`, 'agent_unavailable')
          : new AgentRunError(error.message, 'agent_failed'));
      });
      child.on('close', (code: number | null) => {
        if (reason === 'timeout') return finish(reject, new AgentRunError('Agent did not finish in time', 'agent_timeout'));
        if (reason === 'cancelled') return finish(reject, new AgentRunError('Agent run was cancelled', 'agent_cancelled'));
        if (reason === 'too_large') return finish(reject, new AgentRunError('Agent output was too large', 'agent_bad_output'));
        try {
          // The CLI reports most failures inside the JSON envelope, even with
          // a non-zero exit code, so try that first.
          finish(resolve, parseEnvelope(stdout));
        } catch (error) {
          if (code !== 0 && !stdout.trim()) {
            finish(reject, new AgentRunError(stderr.trim().split('\n').pop() || `Claude Code exited with ${code}`, 'agent_failed', stderr.slice(-2000)));
          } else {
            finish(reject, error);
          }
        }
      });

      child.stdin.on('error', () => {}); // the CLI may exit before reading all input
      child.stdin.end(prompt);
    });
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
};

// Runs once, retrying a single time when the CLI exhausted its schema
// retries: that failure is intermittent and a fresh run usually succeeds.
// The second failure is reported as agent_bad_output.
export const runStructured: RunAgent = async (options) => {
  try {
    return await runOnce(options);
  } catch (error) {
    if (codeOf(error) !== 'agent_schema_retry') throw error;
    try {
      return await runOnce(options);
    } catch (retryError) {
      if (codeOf(retryError) === 'agent_schema_retry') {
        throw new AgentRunError('Agent could not produce output in the required format', 'agent_bad_output');
      }
      throw retryError;
    }
  }
};
