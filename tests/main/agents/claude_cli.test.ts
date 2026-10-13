import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import * as cli from '../../../src/main/agents/claude_cli.ts';

// A stand-in child process that records what it was given.
const fakeSpawn = ({
  stdout = '',
  stderr = '',
  code = 0,
  error = null,
  hang = false,
}: { stdout?: string; stderr?: string; code?: number; error?: Error | null; hang?: boolean } = {}) => {
  const calls: { command: string; args: string[]; options: { cwd: string }; input: () => string }[] = [];
  const spawnFn = (command, args, options): any => {
    const child: any = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let input = '';
    child.stdin.on('data', (chunk) => {
      input += chunk;
    });
    child.kill = () => setImmediate(() => child.emit('close', null));
    calls.push({ command, args, options, input: () => input });
    setImmediate(() => {
      if (error) return child.emit('error', error);
      if (hang) return;
      child.stdout.end(stdout);
      child.stderr.end(stderr);
      child.emit('close', code);
    });
    return child;
  };
  return { spawnFn, calls };
};

const envelope = (fields) => JSON.stringify({ is_error: false, subtype: 'success', total_cost_usd: 0.05, ...fields });
const base = { prompt: 'p', systemPrompt: 's', schema: { type: 'object' } };

test('cliArgs() isolates the run: no tools, settings, MCP, or session files', () => {
  const args = cli.cliArgs({ systemPrompt: 's', schema: { type: 'object' } });
  const flag = (name) => args[args.indexOf(name) + 1];
  assert.equal(flag('--tools'), '');
  assert.ok(args.includes('--restricted'));
  assert.ok(args.includes('--strict-mcp-config'));
  assert.ok(args.includes('--no-session-persistence'));
  // Cost is recorded, never capped.
  assert.ok(!args.includes('--max-budget-usd'));
  assert.equal(flag('--output-format'), 'json');
  assert.equal(flag('--json-schema'), '{"type":"object"}');
});

test('childEnv() drops Claude Code session variables and applies PATH', () => {
  const env = cli.childEnv({ HOME: '/h', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'x', CLAUDE_PID: '9', CLAUDE_EFFORT: 'hi', ANTHROPIC_API_KEY: 'k' }, '/p');
  assert.deepEqual(Object.keys(env).sort(), ['ANTHROPIC_API_KEY', 'HOME', 'NO_COLOR', 'PATH']);
  assert.equal(env.PATH, '/p');
});

test('runStructured() sends the prompt on stdin, not argv, and returns structured output', async () => {
  const { spawnFn, calls } = fakeSpawn({
    stdout: envelope({
      structured_output: { ok: true },
      usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 },
      modelUsage: { 'claude-haiku-5-5': { outputTokens: 1 }, 'claude-sonnet-5-5': { outputTokens: 3 } },
    }),
  });
  const result = await cli.runStructured({ ...base, prompt: 'secret requirement', spawnFn });
  assert.deepEqual(result, {
    output: { ok: true },
    costUsd: 0.05,
    call: { cli: 'claude', provider: 'anthropic', model: 'claude-sonnet-5-5', costUsd: 0.05, tokens: { input: 10, output: 4, cacheRead: 2, cacheWrite: 1 } },
  });
  assert.equal(calls[0].input(), 'secret requirement');
  assert.ok(!calls[0].args.some((arg) => arg.includes('secret requirement')));
});

test('runStructured() runs in a fresh empty directory and removes it', async () => {
  const { spawnFn, calls } = fakeSpawn({ stdout: envelope({ structured_output: {} }) });
  await cli.runStructured({ ...base, spawnFn });
  const { cwd } = calls[0].options;
  assert.ok(cwd.startsWith(path.join(os.tmpdir(), 'taskpilot-agent-')));
  await assert.rejects(() => fs.access(cwd));
});

test('runStructured() falls back to parsing result when structured_output is absent', async () => {
  const { spawnFn } = fakeSpawn({ stdout: envelope({ result: '{"a":1}' }) });
  assert.deepEqual((await cli.runStructured({ ...base, spawnFn })).output, { a: 1 });
});

test('runStructured() maps failures to stable codes', async () => {
  const cases: [object, string][] = [
    [{ error: Object.assign(new Error('nope'), { code: 'ENOENT' }) }, 'agent_unavailable'],
    [{ stdout: 'not json' }, 'agent_bad_output'],
    [{ stdout: envelope({ result: 'plain text' }) }, 'agent_bad_output'],
    [{ stdout: envelope({ is_error: true, subtype: 'error_during_execution', result: 'boom' }) }, 'agent_failed'],
    [{ stdout: '', stderr: 'Invalid API key\n', code: 1 }, 'agent_failed'],
  ];
  for (const [options, code] of cases) {
    const { spawnFn } = fakeSpawn(options);
    await assert.rejects(() => cli.runStructured({ ...base, spawnFn }), { code }, JSON.stringify(options));
  }
});

test('runStructured() reads the error envelope even when the CLI exits non-zero', async () => {
  const { spawnFn } = fakeSpawn({ stdout: envelope({ is_error: true, subtype: 'error_during_execution', result: 'boom' }), code: 1 });
  await assert.rejects(() => cli.runStructured({ ...base, spawnFn }), { code: 'agent_failed', message: 'boom' });
});

test('runStructured() retries once when the CLI exhausts its schema retries', async () => {
  const exhausted = envelope({ is_error: true, subtype: 'error_max_structured_output_retries' });
  let calls = 0;
  const flaky = (...args: [string, string[], object]) => {
    calls += 1;
    return fakeSpawn({ stdout: calls === 1 ? exhausted : envelope({ structured_output: { ok: 1 } }) }).spawnFn(...args);
  };
  assert.deepEqual((await cli.runStructured({ ...base, spawnFn: flaky })).output, { ok: 1 });
  assert.equal(calls, 2);

  let always = 0;
  const broken = (...args: [string, string[], object]) => {
    always += 1;
    return fakeSpawn({ stdout: exhausted }).spawnFn(...args);
  };
  await assert.rejects(() => cli.runStructured({ ...base, spawnFn: broken }), { code: 'agent_bad_output' });
  assert.equal(always, 2, 'only one retry');
});

test('runStructured() times out and can be cancelled', async () => {
  const slow = fakeSpawn({ hang: true });
  await assert.rejects(() => cli.runStructured({ ...base, spawnFn: slow.spawnFn, timeoutMs: 20 }), { code: 'agent_timeout' });

  const controller = new AbortController();
  const pending = cli.runStructured({ ...base, spawnFn: fakeSpawn({ hang: true }).spawnFn, signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending, { code: 'agent_cancelled' });

  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(() => cli.runStructured({ ...base, spawnFn: slow.spawnFn, signal: aborted.signal }), { code: 'agent_cancelled' });
});
