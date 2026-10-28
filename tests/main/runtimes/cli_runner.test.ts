import { test, onTestFinished, vi } from 'vitest';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import { loadNativeModelProfile } from '../../../src/main/runtimes/native_model_profile.ts';
import { probeCli } from '../../../src/main/runtimes/cli_environment.ts';
import { parseStructuredOutput } from '../../../src/main/runtimes/structured_output.ts';
import { runStructured } from '../../../src/main/runtimes/cli_runner.ts';
import type { RunStructuredOptions, SpawnFn } from '../../../src/main/runtimes/claude_cli.ts';
import type { AgentRuntimeConfig } from '../../../src/shared/agent_runtime.ts';
import { tempDir } from '../../fixtures/temp_dir.ts';

const options = { prompt: 'private prompt', systemPrompt: 'system', schema: { type: 'object' } } satisfies RunStructuredOptions;
const piConfig = { cli: 'pi', model: 'provider/model-x', thinking: 'high' } satisfies AgentRuntimeConfig;

type FakeChild = EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: () => boolean; pid?: number };
const fakeChild = () => {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {
    setImmediate(() => child.emit('close', null));
    return true;
  };
  return child;
};

test.each([
  ['Pi assistant JSONL', '{"type":"assistant","message":{"content":[{"type":"text","text":"{\\"ok\\":true}"}]}}', { ok: true }],
  ['Pi message_end', '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"{\\"pi\\":true}"}]}}', { pi: true }],
  ['OpenCode text part', '{"type":"text","part":{"type":"text","text":"{\\"opencode\\":true}"}}', { opencode: true }],
  ['Grok result envelope', '{"result":{"grok":true}}', { grok: true }],
])('%s output is parsed', (_name, input, expected) => {
  assert.deepEqual(parseStructuredOutput(input), expected);
});

test('OpenCode tool initialization fails closed', () => {
  assert.throws(() => parseStructuredOutput('{"type":"step_start","tools":["read"]}'), { code: 'agent_unavailable' });
});

test('Codex structured analysis is rejected before process launch', async () => {
  const config = { cli: 'codex', model: '', thinking: 'default' } satisfies AgentRuntimeConfig;
  await assert.rejects(
    () =>
      runStructured(
        {
          ...options,
          spawnFn: () => {
            throw new Error('must not launch');
          },
        },
        config,
      ),
    { code: 'agent_unavailable' },
  );
});

test('Grok probe reports missing supported credentials without launching model', async () => {
  const home = await tempDir('taskpilot-grok-auth-test-');
  const previousHome = process.env.HOME;
  const previousKey = process.env.XAI_API_KEY;
  process.env.HOME = home;
  delete process.env.XAI_API_KEY;
  try {
    const status = await probeCli({ cli: 'grok', model: '', thinking: 'default' });
    assert.equal(status.available, false);
    assert.match(status.reason ?? '', /XAI_API_KEY|auth\.json/);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousKey === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = previousKey;
  }
});

test('private analysis text never appears in the process arguments', async () => {
  const child = fakeChild();
  let observedArgs: string[] = [];
  let input = '';
  const spawnFn: SpawnFn = ((_: string, args: string[]) => {
    observedArgs = args;
    child.stdin.on('data', (chunk) => {
      input += chunk.toString();
    });
    setImmediate(() => {
      child.stdout.end('{"type":"assistant","message":{"content":"{\\"ready\\":true}"}}');
      child.emit('close', 0);
    });
    return child;
  }) as unknown as SpawnFn;
  const result = await runStructured({ ...options, spawnFn }, piConfig);
  assert.deepEqual(result.output, { ready: true });
  assert.equal(result.costUsd, null);
  assert.ok(input.includes('private prompt'));
  assert.ok(!observedArgs.some((arg) => arg.includes('private prompt')));
});

test('oversized output is rejected and terminates the process', async () => {
  const child = fakeChild();
  let killed = false;
  child.kill = () => {
    killed = true;
    setImmediate(() => child.emit('close', null));
    return true;
  };
  const spawnFn: SpawnFn = (() => {
    setImmediate(() => child.stdout.write('x'.repeat(4 * 1024 * 1024 + 1)));
    return child;
  }) as unknown as SpawnFn;
  await assert.rejects(() => runStructured({ ...options, spawnFn }, piConfig), { code: 'agent_bad_output' });
  assert.equal(killed, true);
});

test('abort cancels and terminates the process without timer delays', async () => {
  const controller = new AbortController();
  const child = fakeChild();
  let killed = false;
  child.kill = () => {
    killed = true;
    setImmediate(() => child.emit('close', null));
    return true;
  };
  const spawnFn: SpawnFn = (() => {
    setImmediate(() => controller.abort());
    return child;
  }) as unknown as SpawnFn;
  await assert.rejects(() => runStructured({ ...options, signal: controller.signal, spawnFn }, piConfig), { code: 'agent_cancelled' });
  assert.equal(killed, true);
});

test.each([
  [
    'terminal error overrides result',
    [
      { type: 'result', structured_output: { ok: true } },
      { type: 'error', error: { message: 'provider failure' } },
    ],
    'agent_failed',
  ],
  [
    'tools cannot be hidden by result',
    [
      { type: 'system', subtype: 'init', tools: ['Read'] },
      { type: 'result', is_error: false, structured_output: { ok: true } },
    ],
    'agent_unavailable',
  ],
])('%s', (_name, events, code) => {
  const output = events.map((event) => JSON.stringify(event)).join('\n');
  assert.throws(() => parseStructuredOutput(output), { code });
});

test('a nonzero CLI exit cannot turn stdout JSON into a successful review', async () => {
  const child = fakeChild();
  const spawnFn = (() => {
    setImmediate(() => {
      child.stdout.end('{"type":"assistant","message":{"content":"{\\"ok\\":true}"}}');
      child.emit('close', 2);
    });
    return child;
  }) as unknown as SpawnFn;
  await assert.rejects(runStructured({ ...options, spawnFn }, piConfig), { code: 'agent_failed' });
});

test('unexpected initialized tools terminate the CLI before waiting for its result', async () => {
  const child = fakeChild();
  let terminated = false;
  child.kill = () => {
    terminated = true;
    setImmediate(() => child.emit('close', null));
    return true;
  };
  const spawnFn = (() => {
    setImmediate(() => child.stdout.write('{"type":"system","subtype":"init","tools":["Read"]}\n'));
    return child;
  }) as unknown as SpawnFn;
  await assert.rejects(runStructured({ ...options, spawnFn }, piConfig), { code: 'agent_unavailable' });
  assert.equal(terminated, true);
});

test('assistant JSON retains Chinese text when UTF8 characters cross stdout chunks', async () => {
  const child = fakeChild();
  const event = Buffer.from(
    JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify({ title: '模块接口' }) }] } }),
  );
  const split = event.indexOf(Buffer.from('模')) + 1;
  const spawnFn = (() => {
    setImmediate(() => {
      child.stdout.write(event.subarray(0, split));
      child.stdout.end(event.subarray(split));
      child.emit('close', 0);
    });
    return child;
  }) as unknown as SpawnFn;
  const result = await runStructured({ ...options, spawnFn }, piConfig);
  assert.deepEqual(result.output, { title: '模块接口' });
});

test('Grok can use cached login in its private home without loading user hooks', async () => {
  const home = await tempDir('taskpilot-grok-login-test-');
  const previousHome = process.env.HOME;
  const previousKey = process.env.XAI_API_KEY;
  await fs.mkdir(path.join(home, '.grok'), { mode: 0o700 });
  await fs.writeFile(path.join(home, '.grok', 'auth.json'), JSON.stringify({ 'https://accounts.x.ai/sign-in': { key: 'offline-login-fixture' } }), {
    mode: 0o600,
  });
  await fs.writeFile(path.join(home, '.grok', 'config.toml'), '[hooks]\ncommand="must-not-run"\n');
  const program = path.join(home, 'private-login-cli.mjs');
  await fs.writeFile(
    program,
    `import fs from 'node:fs/promises';import path from 'node:path';import assert from 'node:assert/strict';const root=process.env.GROK_HOME;assert.ok(root&&root.startsWith(process.env.HOME));const auth=JSON.parse(await fs.readFile(path.join(root,'auth.json'),'utf8'));assert.equal(auth['https://accounts.x.ai/sign-in'].key,'offline-login-fixture');const mode=(await fs.stat(path.join(root,'auth.json'))).mode;assert.equal(mode&0o777,0o600);const config=await fs.readFile(path.join(root,'config.toml'),'utf8');assert.ok(!config.includes('hooks')&&!config.includes('must-not-run'));process.stdout.write(JSON.stringify({type:'result',structured_output:{authenticated:true}}));`,
  );
  process.env.HOME = home;
  delete process.env.XAI_API_KEY;
  try {
    const result = await runStructured(
      {
        ...options,
        spawnFn: (_command, args, childOptions) => spawn(process.execPath, [program, ...args], { ...childOptions, stdio: ['pipe', 'pipe', 'pipe'] }),
      },
      { cli: 'grok', model: '', thinking: 'default' },
    );
    assert.deepEqual(result.output, { authenticated: true });
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousKey === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = previousKey;
  }
});

test('native Pi and Grok provider defaults reach isolated CLI processes without loading user resources', async () => {
  const home = await tempDir('taskpilot-native-defaults-test-');
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  const piRoot = path.join(home, '.pi', 'agent');
  const grokRoot = path.join(home, '.grok');
  await fs.mkdir(piRoot, { recursive: true, mode: 0o700 });
  await fs.mkdir(grokRoot, { recursive: true, mode: 0o700 });
  await fs.writeFile(
    path.join(piRoot, 'models.json'),
    JSON.stringify({
      providers: {
        gateway: {
          api: 'openai-compatible',
          baseUrl: 'https://provider.invalid/v1',
          apiKey: 'fixture-model-key',
          models: [{ id: 'native-model', name: 'Native model', contextWindow: 8192, thinkingLevelMap: { high: 'high' } }],
        },
      },
    }),
  );
  await fs.writeFile(
    path.join(piRoot, 'settings.json'),
    JSON.stringify({ defaultProvider: 'gateway', defaultModel: 'native-model', defaultThinkingLevel: 'high', extensions: ['must-not-load'] }),
  );
  await fs.writeFile(
    path.join(grokRoot, 'config.toml'),
    '[models]\ndefault = "native-grok"\ndefault_reasoning_effort = "high"\nallowed_models = ["native-grok", "safe-*", "fixture"]\n[model.native-grok]\nname = "Native Grok"\nmodel = "wire-id"\nbase_url = "https://provider.invalid/v1"\napi_backend = "chat_completions"\napi_key = "fixture-grok-key"\nenv_key = ["XAI_API_KEY", "MUST_NOT_PASS"]\n[hooks]\ncommand = "must-not-load"\n',
  );
  vi.stubEnv('HOME', home);
  vi.stubEnv('PI_CODING_AGENT_DIR', piRoot);
  vi.stubEnv('GROK_HOME', grokRoot);
  vi.stubEnv('XAI_API_KEY', 'fixture-xai-environment-key');
  vi.stubEnv('MUST_NOT_PASS', 'fixture-unapproved-environment-value');
  const program = path.join(home, 'verify-native-profile.mjs');
  const makeSpawn = (cli: 'pi' | 'grok'): SpawnFn =>
    ((_: string, args: string[], childOptions) =>
      spawn(process.execPath, [program, cli, ...args], { ...childOptions, stdio: ['pipe', 'pipe', 'pipe'] })) as unknown as SpawnFn;
  await fs.writeFile(
    program,
    `import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';const cli=process.argv[2];if(cli==='pi'){const root=process.env.PI_CODING_AGENT_DIR;const models=JSON.parse(await fs.readFile(path.join(root,'models.json'),'utf8'));const settings=JSON.parse(await fs.readFile(path.join(root,'settings.json'),'utf8'));assert.equal(models.providers.gateway.apiKey,'fixture-model-key');assert.equal(models.providers.gateway.models[0].id,'native-model');assert.deepEqual(settings,{defaultProvider:'gateway',defaultModel:'native-model',defaultThinkingLevel:'high'});assert.ok(process.argv.includes('--model')&&process.argv.includes('gateway/native-model'));assert.ok(!process.argv.includes('--thinking')&&process.argv.includes('--no-tools')&&process.argv.includes('--no-extensions')&&process.argv.includes('--no-mcp'));assert.ok(!JSON.stringify(models).includes('must-not-load'));}else{const root=process.env.GROK_HOME;const config=await fs.readFile(path.join(root,'config.toml'),'utf8');assert.ok(config.includes('fixture-grok-key')&&config.includes('native-grok')&&config.includes('allowed_models = ['));assert.ok(process.env.XAI_API_KEY==='fixture-xai-environment-key'&&process.env.MUST_NOT_PASS===undefined);assert.ok(!process.argv.includes('fixture-grok-key')&&!process.argv.includes('fixture-xai-environment-key'));assert.ok(!config.includes('hooks')&&!config.includes('must-not-load'));assert.ok(process.argv.includes('--model')&&process.argv.includes('native-grok')&&!process.argv.includes('--reasoning-effort'));assert.ok(process.argv.includes('--no-subagents')&&process.argv.includes('--tools')&&process.argv.includes('--deny'));}process.stdout.write(JSON.stringify({type:'result',structured_output:{native:true}}));`,
  );
  const piResult = await runStructured({ ...options, spawnFn: makeSpawn('pi') }, { cli: 'pi', model: '', thinking: 'default' });
  assert.deepEqual(piResult.output, { native: true });
  const grokResult = await runStructured({ ...options, spawnFn: makeSpawn('grok') }, { cli: 'grok', model: '', thinking: 'default' });
  assert.deepEqual(grokResult.output, { native: true });
});

test.each([
  {
    cli: 'pi' as const,
    relative: '.pi/agent/models.json',
    content: JSON.stringify({ providers: { gateway: { apiKey: '!credential-helper', models: [] } } }),
    problem: /credential command/,
  },
  { cli: 'grok' as const, relative: '.grok/config.toml', content: 'auth_provider_command = "credential-helper"', problem: /authentication command/ },
  {
    cli: 'opencode' as const,
    relative: '.config/opencode/opencode.json',
    content: JSON.stringify({ provider: { gateway: { npm: './private-provider.js', models: {} } } }),
    problem: /unsupported SDK/,
  },
  { cli: 'grok' as const, relative: '.grok/config.toml', content: '[models]\nallowed_models = { blocked = true }', problem: /invalid allowed_models list/ },
  {
    cli: 'opencode' as const,
    relative: '.config/opencode/opencode.json',
    content: JSON.stringify({ provider: { gateway: { npm: '@ai-sdk/openai-compatible', options: { apiKey: '{file:/private/token}' }, models: {} } } }),
    problem: /file-backed credentials/,
  },
])('isolated analysis rejects executable or file-backed native configuration: $cli/$problem', async ({ cli, relative, content, problem }) => {
  const home = await tempDir('taskpilot-native-safety-');
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  vi.stubEnv('HOME', home);
  vi.stubEnv('PI_CODING_AGENT_DIR', path.join(home, '.pi', 'agent'));
  vi.stubEnv('GROK_HOME', path.join(home, '.grok'));
  vi.stubEnv('OPENCODE_CONFIG_DIR', path.join(home, '.config', 'opencode'));
  vi.stubEnv('OPENCODE_CONFIG', '');
  const file = path.join(home, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
  await assert.rejects(() => loadNativeModelProfile(cli, path.join(home, 'private')), problem);
});

test('malformed native configuration cannot fall back to a different provider or launch inference', async () => {
  const home = await tempDir('taskpilot-native-invalid-');
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  const root = path.join(home, '.pi', 'agent');
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, 'models.json'), '{"apiKey":"private-secret", invalid');
  vi.stubEnv('HOME', home);
  vi.stubEnv('PI_CODING_AGENT_DIR', root);
  const spawnFn = vi.fn<SpawnFn>(() => {
    throw new Error('Inference must not start');
  });
  await assert.rejects(
    () => runStructured({ ...options, spawnFn }, piConfig),
    (error: Error) => {
      assert.match(error.message, /CLI 配置 JSON 无效/);
      assert.doesNotMatch(error.message, /private-secret|apiKey/);
      return true;
    },
  );
  assert.equal(spawnFn.mock.calls.length, 0);
});
