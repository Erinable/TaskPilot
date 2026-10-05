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
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_TIMEOUT_MS = 3 * 60 * 1000;
const DEFAULT_BUDGET_USD = 1;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

class AgentRunError extends Error {
  constructor(message, code, detail) {
    super(message);
    this.name = 'AgentRunError';
    this.code = code;
    if (detail) this.detail = detail;
  }
}

/** Environment for the child: the parent's, minus Claude Code session state. */
function childEnv(base, envPath) {
  const env = {};
  for (const [key, value] of Object.entries(base)) {
    if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_') || key === 'CLAUDE_PID' || key === 'CLAUDE_EFFORT') continue;
    env[key] = value;
  }
  if (envPath) env.PATH = envPath;
  env.NO_COLOR = '1';
  return env;
}

function cliArgs({ systemPrompt, schema, model, budgetUsd }) {
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
}

/** Pulls the structured result out of the CLI's JSON envelope. */
function parseEnvelope(stdout) {
  let envelope;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    throw new AgentRunError('Agent returned output that is not JSON', 'agent_bad_output', stdout.slice(0, 500));
  }
  if (envelope.is_error || envelope.subtype !== 'success') {
    const reason = envelope.subtype === 'error_max_budget_usd' ? 'agent_budget' : 'agent_failed';
    throw new AgentRunError(envelope.result || `Agent run ended with ${envelope.subtype}`, reason);
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
}

/**
 * @param options.prompt user turn, sent on stdin
 * @param options.systemPrompt
 * @param options.schema JSON Schema for the structured output
 * @param options.command CLI executable (default 'claude')
 * @param options.envPath PATH to launch with (see ../shell-env.js)
 * @param options.signal AbortSignal to cancel the run
 * @param options.spawnFn injectable for tests
 * @returns {Promise<{output, costUsd}>}
 */
async function runStructured({
  prompt, systemPrompt, schema, command = 'claude', model = null, envPath = null,
  budgetUsd = DEFAULT_BUDGET_USD, timeoutMs = DEFAULT_TIMEOUT_MS, signal, spawnFn = spawn,
}) {
  if (signal?.aborted) throw new AgentRunError('Agent run was cancelled', 'agent_cancelled');
  // An empty working directory: with no tools there is nothing to read, and
  // the CLI won't discover a project CLAUDE.md from it either.
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'taskpilot-agent-'));
  try {
    return await new Promise((resolve, reject) => {
      let child;
      try {
        child = spawnFn(command, cliArgs({ systemPrompt, schema, model, budgetUsd }), {
          cwd, env: childEnv(process.env, envPath), stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (error) {
        reject(new AgentRunError(`Could not start ${command}: ${error.message}`, 'agent_unavailable'));
        return;
      }

      let stdout = '';
      let stderr = '';
      let settled = false;
      let reason = null;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        fn(value);
      };
      const stop = (why) => {
        reason = why;
        child.kill('SIGTERM');
      };
      const timer = setTimeout(() => stop('timeout'), timeoutMs);
      const onAbort = () => stop('cancelled');
      signal?.addEventListener('abort', onAbort, { once: true });

      child.stdout.on('data', (chunk) => {
        stdout += chunk;
        if (stdout.length > MAX_OUTPUT_BYTES) stop('too_large');
      });
      child.stderr.on('data', (chunk) => {
        if (stderr.length < 64 * 1024) stderr += chunk;
      });
      child.on('error', (error) => {
        finish(reject, error.code === 'ENOENT'
          ? new AgentRunError(`Claude Code CLI not found: ${command}`, 'agent_unavailable')
          : new AgentRunError(error.message, 'agent_failed'));
      });
      child.on('close', (code) => {
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
}

module.exports = { DEFAULT_BUDGET_USD, AgentRunError, childEnv, cliArgs, parseEnvelope, runStructured };
