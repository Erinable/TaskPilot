import { test } from 'vitest';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { CodingExecError, MAX_JSONL_LINE_BYTES, safeChildEnv } from '../../../src/main/coding/coding_process.ts';
import type { SpawnFn } from '../../../src/main/coding/coding_process.ts';
import { runCoding } from '../../../src/main/coding/coding_exec.ts';

class FakeProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  // No pid: a fake one could name a real process group on the host, and
  // killProcessTree would signal it instead of calling kill() below.
  killed: string | undefined;

  kill(signal?: NodeJS.Signals): boolean {
    this.killed = signal;
    queueMicrotask(() => this.emit('close', null, signal));
    return true;
  }
}

const config = { cli: 'codex' as const, model: '', thinking: 'default' as const };

const spawnWith = (write: (process: FakeProcess) => void): SpawnFn =>
  ((command: string, args: readonly string[], options: Record<string, unknown>) => {
    assert.equal(command, '/usr/bin/sudo');
    assert.deepEqual(options.env, safeChildEnv());
    assert.deepEqual(args.slice(-4), ['run', '/Users/taskpilot-coder/TaskPilotRuns/run-1', 'codex', '', 'default'].slice(-4));
    const process = new FakeProcess();
    queueMicrotask(() => write(process));
    return process;
  }) as unknown as SpawnFn;

test('runCoding parses JSONL narrative, tools, and usage without putting prompt in argv', async () => {
  const prompt = 'secret prompt must stay on stdin';
  let received = '';
  const result = await runCoding({
    runName: '/Users/taskpilot-coder/TaskPilotRuns/run-1',
    prompt,
    spawnFn: ((command, args, options) => {
      assert.equal(command, '/usr/bin/sudo');
      assert.deepEqual(options.env, safeChildEnv());
      assert.equal(args.includes(prompt), false);
      const process = new FakeProcess();
      process.stdin.on('data', (chunk) => {
        received += chunk.toString();
      });
      queueMicrotask(() => {
        process.stdout.write('{"type":"item.started","item":{"type":"shell"}}\n');
        process.stdout.write('{"type":"item.completed","item":{"type":"agent_message","text":"done"}}\n');
        process.stdout.write('{"type":"turn.completed","usage":{"input_tokens":3,"cached_input_tokens":1,"output_tokens":2,"reasoning_output_tokens":1}}\n');
        process.stdout.end();
        process.emit('close', 0, null);
      });
      return process;
    }) as unknown as SpawnFn,
    config,
  });
  assert.equal(received, prompt);
  assert.equal(result.usage.inputTokens, 3);
  assert.equal(result.usage.costUsd, null);
  assert.equal(
    result.events.some((event) => event.type === 'tool'),
    true,
  );
});

test('safeChildEnv excludes parent credentials', () => {
  process.env.TASKPILOT_TEST_SENTINEL = 'must-not-cross';
  assert.equal('TASKPILOT_TEST_SENTINEL' in safeChildEnv(), false);
  delete process.env.TASKPILOT_TEST_SENTINEL;
});

test('runCoding reports nonzero exits and bounded oversized lines', async () => {
  await assert.rejects(
    runCoding({
      runName: '/Users/taskpilot-coder/TaskPilotRuns/run-1',
      prompt: 'x',
      config,
      spawnFn: spawnWith((process) => {
        process.stderr.end('api_key=secret-value');
        process.emit('close', 7, null);
      }),
    }),
    (error: unknown) => error instanceof CodingExecError && error.code === 'coding_exit_failed' && !error.stderr.includes('secret-value'),
  );
  await assert.rejects(
    runCoding({
      runName: '/Users/taskpilot-coder/TaskPilotRuns/run-1',
      prompt: 'x',
      config,
      spawnFn: spawnWith((process) => {
        process.stdout.write(`{"type":"item.completed","item":{"type":"agent_message","text":"${'x'.repeat(MAX_JSONL_LINE_BYTES + 1)}"}}\n`);
      }),
    }),
    (error: unknown) => error instanceof CodingExecError && error.code === 'coding_oversized',
  );
});

test('runCoding cancellation terminates the child process', async () => {
  const controller = new AbortController();
  const promise = runCoding({
    runName: '/Users/taskpilot-coder/TaskPilotRuns/run-1',
    prompt: 'x',
    config,
    signal: controller.signal,
    spawnFn: spawnWith(() => controller.abort()),
  });
  await assert.rejects(promise, (error: unknown) => error instanceof CodingExecError && error.code === 'coding_aborted');
});

test('runCoding rejects unsupported CLI thinking without spawning a host command', async () => {
  let spawned = false;
  await assert.rejects(
    runCoding({
      runName: '/Users/taskpilot-coder/TaskPilotRuns/run-1',
      prompt: 'x',
      config: { cli: 'claude', model: '', thinking: 'off' },
      spawnFn: (() => {
        spawned = true;
        throw new Error('must not spawn');
      }) as unknown as SpawnFn,
    }),
    (error: unknown) => error instanceof CodingExecError && error.code === 'coding_protocol',
  );
  assert.equal(spawned, false);
});

test('runCoding normalizes Claude JSONL text, thinking, tools, and usage', async () => {
  const result = await runCoding({
    runName: '/Users/taskpilot-coder/TaskPilotRuns/run-1',
    prompt: 'make a change',
    config: { cli: 'claude', model: 'claude-model', thinking: 'high' },
    spawnFn: ((command, args, options) => {
      assert.equal(command, '/usr/bin/sudo');
      assert.deepEqual(options.env, safeChildEnv());
      assert.equal(args.includes('make a change'), false);
      const child = new FakeProcess();
      queueMicrotask(() => {
        child.stdout.end(
          '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"plan"},{"type":"text","text":"done"},{"type":"tool_use","name":"Write"}],"usage":{"input_tokens":4,"output_tokens":2}}}\n',
        );
        child.emit('close', 0, null);
      });
      return child;
    }) as unknown as SpawnFn,
  });
  assert.equal(result.output, 'done');
  assert.equal(result.usage.inputTokens, 4);
  assert.equal(result.usage.outputTokens, 2);
  assert.deepEqual(
    result.events.map(({ type }) => type),
    ['thinking', 'tool', 'text'],
  );
});

test('runCoding parses terminal JSONL events for Pi, Grok, and OpenCode', async () => {
  const cases = [
    {
      cli: 'pi' as const,
      line: '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"pi done"}],"usage":{"input_tokens":3,"output_tokens":1}}}',
      text: 'pi done',
    },
    {
      cli: 'grok' as const,
      line: '{"type":"message","message":{"role":"assistant","content":"grok done","usage":{"prompt_tokens":5,"completion_tokens":2}}}',
      text: 'grok done',
    },
    { cli: 'opencode' as const, line: '{"type":"text","part":{"text":"opencode done"}}', text: 'opencode done' },
  ];
  for (const fixture of cases) {
    const result = await runCoding({
      runName: '/Users/taskpilot-coder/TaskPilotRuns/run-1',
      prompt: 'make a change',
      config: { cli: fixture.cli, model: '', thinking: 'default' },
      spawnFn: ((command, args, options) => {
        assert.equal(command, '/usr/bin/sudo');
        assert.deepEqual(options.env, safeChildEnv());
        assert.equal(args.includes('make a change'), false);
        const child = new FakeProcess();
        queueMicrotask(() => {
          child.stdout.write(`${fixture.line}\n`);
          child.emit('close', 0, null);
        });
        return child;
      }) as unknown as SpawnFn,
    });
    assert.equal(result.output, fixture.text);
  }
});

test('runCoding rejects native model errors even after a zero exit', async () => {
  await assert.rejects(
    runCoding({
      runName: '/Users/taskpilot-coder/TaskPilotRuns/run-1',
      prompt: 'x',
      config: { cli: 'claude', model: '', thinking: 'default' },
      spawnFn: ((command, args, options) => {
        assert.equal(command, '/usr/bin/sudo');
        assert.deepEqual(options.env, safeChildEnv());
        const child = new FakeProcess();
        queueMicrotask(() => {
          child.stdout.write('{"type":"result","is_error":true,"result":"model unavailable"}\n');
          child.emit('close', 0, null);
        });
        return child;
      }) as unknown as SpawnFn,
    }),
    (error: unknown) => error instanceof CodingExecError && error.code === 'coding_protocol' && error.message.includes('model unavailable'),
  );
});
