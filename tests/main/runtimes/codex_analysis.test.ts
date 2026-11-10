/** @module-tag integration */
import { test, onTestFinished, vi } from 'vitest';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import { runCodexAnalysis } from '../../../src/main/runtimes/codex_analysis.ts';
import type { prepareCodexProfile } from '../../../src/main/runtimes/codex_profile.ts';
import { codexAnalysisArgs, validateCodexAnalysisVersion } from '../../../src/main/runtimes/codex_config.ts';
import { restrictedCodexCatalog } from '../../../src/main/runtimes/codex_catalog.ts';
import type { AgentRuntimeConfig } from '../../../src/shared/agent_runtime.ts';
import type { RunStructuredOptions, SpawnFn } from '../../../src/main/runtimes/claude_cli.ts';
import { tempDir } from '../../fixtures/temp_dir.ts';

const options = {
  prompt: 'private requirement text',
  systemPrompt: 'private system instructions',
  schema: { type: 'object', required: ['ready'], properties: { ready: { type: 'boolean' } } },
} satisfies RunStructuredOptions;
const config = { cli: 'codex', model: 'review-model', thinking: 'high' } satisfies AgentRuntimeConfig;
const usage = { input_tokens: 100, cached_input_tokens: 40, output_tokens: 5 };
const jsonl = (...events: object[]) => events.map((event) => JSON.stringify(event)).join('\n');
const success = () =>
  jsonl(
    { type: 'thread.started', thread_id: '0195bd8e-8a90-7000-9c89-ccca8779dafe' },
    { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: '{"ready":true}' } },
    { type: 'turn.completed', usage },
  );
type Profile = Awaited<ReturnType<typeof prepareCodexProfile>>;
const profileFixture = (overrides: Partial<Profile> = {}) => {
  let root = '';
  const prepare = async (directory: string): Promise<Profile> => {
    root = directory;
    const codex = path.join(directory, 'codex');
    await fs.mkdir(codex, { mode: 0o700 });
    await fs.writeFile(path.join(codex, 'config.toml'), 'model = "native-model"\n', { mode: 0o600 });
    return {
      directory: codex,
      environment: {},
      provider: 'openai',
      model: 'native-model',
      thinking: 'medium',
      metadata: [],
      ...overrides,
      syncCredentials: overrides.syncCredentials ?? (async () => {}),
    };
  };
  return { prepare, root: () => root };
};
type FakeChild = EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: (signal?: NodeJS.Signals) => boolean };
const fakeChild = () => {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {
    queueMicrotask(() => child.emit('close', null));
    return true;
  };
  return child;
};
const spawnFake = (child: FakeChild, run: () => void): SpawnFn =>
  (() => {
    queueMicrotask(run);
    return child;
  }) as unknown as SpawnFn;
const missing = (file: string) => assert.rejects(fs.access(file), { code: 'ENOENT' });

test('Codex child receives private homes, prompt on stdin, schema and a tool-free catalog rather than user resources', async () => {
  const directory = await tempDir('taskpilot-codex-child-');
  const program = path.join(directory, 'check-child.mjs');
  await fs.writeFile(
    program,
    [
      "import assert from 'node:assert/strict'; import fs from 'node:fs/promises'; import path from 'node:path';",
      'const args = process.argv.slice(2); const flags = name => args[args.indexOf(name) + 1];',
      "const settings = args.flatMap((entry, index) => entry === '-c' ? [args[index + 1]] : []);",
      "for (const flag of ['--json','--ephemeral','--ignore-rules','--strict-config','--skip-git-repo-check','--output-schema']) assert.ok(args.includes(flag), flag);",
      "assert.equal(flags('--sandbox'), 'read-only'); assert.equal(flags('--model'), 'review-model'); assert.equal(args.at(-1), '-');",
      "assert.ok(!args.join(' ').includes('private requirement text')); assert.ok(!args.join(' ').includes('private system instructions'));",
      "for (const setting of ['approval_policy=\"never\"','web_search=\"disabled\"','mcp_servers={}','features.shell_tool=false','features.unified_exec=false','features.multi_agent=false','features.hooks=false','tools.update_plan.enabled=false']) assert.ok(settings.includes(setting), setting);",
      'assert.ok(settings.includes(\'model_reasoning_effort="high"\'));',
      "const filename = name => JSON.parse(settings.find(value => value.startsWith(name + '=')).slice(name.length + 1));",
      "const schemaPath = flags('--output-schema'); const instructions = filename('model_instructions_file'); const catalogFile = filename('model_catalog_json');",
      "const root = path.dirname(schemaPath); assert.equal(process.cwd(), await fs.realpath(path.join(root, 'work'))); assert.equal(process.env.HOME, path.join(root, 'home')); assert.equal(process.env.CODEX_HOME, path.join(root, 'codex')); assert.equal(process.env.TMPDIR, path.join(root, 'tmp'));",
      "assert.equal(process.env.CODEX_THREAD_ID, undefined); assert.equal(process.env.CODEX_SESSION_ID, undefined); assert.equal(process.env.CLAUDECODE, undefined); assert.equal(process.env.MUST_NOT_PASS, undefined); assert.equal(process.env.FIXTURE_GATEWAY_KEY, 'fixture-provider-key');",
      "const schema = JSON.parse(await fs.readFile(schemaPath, 'utf8')); assert.deepEqual(schema.required, ['ready']);",
      "const prompt = await fs.readFile(instructions, 'utf8'); assert.ok(prompt.startsWith('private system instructions'));",
      'for (const file of [schemaPath, instructions, catalogFile]) assert.equal((await fs.stat(file)).mode & 0o777, 0o600);',
      'for (const folder of [root, process.cwd(), process.env.HOME, process.env.CODEX_HOME, process.env.TMPDIR]) assert.equal((await fs.stat(folder)).mode & 0o777, 0o700);',
      "const catalog = JSON.parse(await fs.readFile(catalogFile, 'utf8')); const model = catalog.models[0]; assert.equal(model.slug, 'review-model'); assert.equal(model.shell_type, 'disabled'); assert.equal(model.apply_patch_tool_type, null); assert.deepEqual(model.experimental_supported_tools, []); assert.deepEqual(model.input_modalities, ['text']); assert.equal(model.supports_search_tool, false); assert.equal(JSON.stringify(catalog).includes('must-not-copy'), false);",
      "let input = ''; for await (const chunk of process.stdin) input += chunk; assert.equal(input, 'private requirement text');",
      `process.stdout.write(${JSON.stringify(success())});`,
    ].join('\n'),
  );
  const profile = profileFixture({
    provider: 'fixture-gateway',
    environment: { FIXTURE_GATEWAY_KEY: 'fixture-provider-key' },
    metadata: [
      {
        slug: 'review-model',
        shell_type: 'must-not-copy',
        model_messages: { instructions_template: 'must-not-copy' },
        experimental_supported_tools: ['must-not-copy'],
        apply_patch_tool_type: 'freeform',
      },
    ],
  });
  vi.stubEnv('CODEX_HOME', '/must-not-inherit-codex-home');
  vi.stubEnv('CODEX_THREAD_ID', 'must-not-inherit-thread');
  vi.stubEnv('CODEX_SESSION_ID', 'must-not-inherit-session');
  vi.stubEnv('CLAUDECODE', 'must-not-inherit-claude');
  vi.stubEnv('MUST_NOT_PASS', 'fixture-unrelated-secret');
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  const result = await runCodexAnalysis(
    { ...options, envPath: '/usr/bin:/bin', spawnFn: (_command, args, spawnOptions) => spawn(process.execPath, [program, ...args], spawnOptions) },
    config,
    { prepare: profile.prepare },
  ).catch((error: unknown) => assert.fail(error instanceof Error && 'detail' in error ? String(error.detail) : String(error)));
  assert.deepEqual(result.output, { ready: true });
  assert.deepEqual(result.call, {
    cli: 'codex',
    provider: 'fixture-gateway',
    model: 'review-model',
    costUsd: null,
    tokens: { input: 60, output: 5, cacheRead: 40, cacheWrite: 0 },
  });
  assert.equal(result.costUsd, null);
  await missing(profile.root());
});

test.each([
  ['selected role model and thinking', { model: 'role-model', thinking: 'xhigh' }, 'option-model', 'role-model', 'xhigh'],
  ['option model and profile thinking', { model: '', thinking: 'default' }, 'option-model', 'option-model', 'medium'],
  ['native model and thinking', { model: '', thinking: 'default' }, '', 'native-model', 'medium'],
] as const)('Codex uses %s without exposing prompts in argv', async (_name, settings, requestedModel, expectedModel, expectedThinking) => {
  const profile = profileFixture();
  const child = fakeChild();
  let args: string[] = [];
  let input = '';
  child.stdin.on('data', (chunk) => {
    input += chunk.toString();
  });
  const spawnFn: SpawnFn = ((_command: string, values: string[]) => {
    args = values;
    queueMicrotask(() => {
      child.stdout.end(success());
      child.emit('close', 0);
    });
    return child;
  }) as unknown as SpawnFn;
  const result = await runCodexAnalysis({ ...options, model: requestedModel, spawnFn }, { ...config, ...settings }, { prepare: profile.prepare });
  assert.equal(args[args.indexOf('--model') + 1], expectedModel);
  assert.ok(args.includes(`model_reasoning_effort=${JSON.stringify(expectedThinking)}`));
  assert.equal(input, options.prompt);
  assert.ok(args.every((value) => !value.includes(options.prompt)));
  assert.deepEqual(result.output, { ready: true });
  await missing(profile.root());
});

test('Codex refuses a missing default model before starting a child and removes scratch files', async () => {
  const profile = profileFixture({ model: null });
  let spawned = false;
  await assert.rejects(
    runCodexAnalysis(
      {
        ...options,
        spawnFn: (() => {
          spawned = true;
          throw new Error('must not run');
        }) as SpawnFn,
      },
      { ...config, model: '' },
      { prepare: profile.prepare },
    ),
    { code: 'agent_unavailable' },
  );
  assert.equal(spawned, false);
  await missing(profile.root());
});

test('Codex terminates an observed tool item before waiting for a final result', async () => {
  const profile = profileFixture();
  const child = fakeChild();
  let terminated = false;
  child.kill = () => {
    terminated = true;
    queueMicrotask(() => child.emit('close', null));
    return true;
  };
  const spawnFn = spawnFake(child, () => {
    child.stdout.write(
      `${jsonl({ type: 'turn.started' }, { type: 'item.started', item: { id: 'unsafe', type: 'command_execution', command: 'must-not-run' } })}\n`,
    );
  });
  await assert.rejects(runCodexAnalysis({ ...options, spawnFn }, config, { prepare: profile.prepare }), { code: 'agent_unavailable' });
  assert.equal(terminated, true);
  await missing(profile.root());
});

test('Codex rejects a late failed turn and retains terminal usage reported before failure', async () => {
  const profile = profileFixture();
  const child = fakeChild();
  const spawnFn = spawnFake(child, () => {
    child.stdout.write(`${success()}\n${JSON.stringify({ type: 'turn.failed', error: { message: 'failed after result' }, usage })}\n`);
  });
  await assert.rejects(runCodexAnalysis({ ...options, spawnFn }, config, { prepare: profile.prepare }), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'agent_failed');
    assert.deepEqual((error as { call?: unknown }).call, {
      cli: 'codex',
      provider: 'openai',
      model: 'review-model',
      costUsd: null,
      tokens: { input: 60, output: 5, cacheRead: 40, cacheWrite: 0 },
    });
    return true;
  });
  await missing(profile.root());
});

test('a nonzero Codex exit retains reported usage and redacts stderr detail', async () => {
  const profile = profileFixture();
  const child = fakeChild();
  const spawnFn = spawnFake(child, () => {
    child.stdout.end(success());
    child.stderr.write('api_key=fixture-secret');
    child.emit('close', 3);
  });
  await assert.rejects(runCodexAnalysis({ ...options, spawnFn }, config, { prepare: profile.prepare }), (error: unknown) => {
    const failure = error as { code?: string; call?: { tokens?: unknown }; detail?: string };
    assert.equal(failure.code, 'agent_failed');
    assert.deepEqual(failure.call?.tokens, { input: 60, output: 5, cacheRead: 40, cacheWrite: 0 });
    assert.equal(failure.detail?.includes('fixture-secret'), false);
    assert.match(failure.detail ?? '', /redacted/);
    return true;
  });
  await missing(profile.root());
});

test('Codex output preserves a multibyte assistant message split across stdout chunks', async () => {
  const profile = profileFixture();
  const child = fakeChild();
  const output = Buffer.from(success().replace('{\\"ready\\":true}', '{\\"标题\\":\\"模块接口\\"}'));
  const split = output.indexOf(Buffer.from('模')) + 1;
  assert.ok(split > 0);
  const spawnFn = spawnFake(child, () => {
    child.stdout.write(output.subarray(0, split));
    child.stdout.end(output.subarray(split));
    child.emit('close', 0);
  });
  const result = await runCodexAnalysis({ ...options, spawnFn }, config, { prepare: profile.prepare });
  assert.deepEqual(result.output, { 标题: '模块接口' });
  await missing(profile.root());
});

test('cancelled Codex analysis stops the child and removes its private files', async () => {
  const profile = profileFixture();
  const child = fakeChild();
  const controller = new AbortController();
  const launched = Promise.withResolvers<void>();
  let stopped = false;
  child.kill = () => {
    stopped = true;
    queueMicrotask(() => child.emit('close', null));
    return true;
  };
  const spawnFn = spawnFake(child, () => launched.resolve());
  const running = runCodexAnalysis({ ...options, spawnFn, signal: controller.signal }, config, { prepare: profile.prepare });
  const rejected = assert.rejects(running, { code: 'agent_cancelled' });
  await launched.promise;
  controller.abort();
  await rejected;
  assert.equal(stopped, true);
  await missing(profile.root());
});

test('Codex timeout stops the child using the operation deadline', async () => {
  vi.useFakeTimers();
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const profile = profileFixture();
  const child = fakeChild();
  const launched = Promise.withResolvers<void>();
  const spawnFn = spawnFake(child, () => launched.resolve());
  const running = runCodexAnalysis({ ...options, spawnFn, timeoutMs: 20 }, config, { prepare: profile.prepare });
  const rejected = assert.rejects(running, { code: 'agent_timeout' });
  await launched.promise;
  await vi.advanceTimersByTimeAsync(20);
  await rejected;
  await missing(profile.root());
});

test('Codex refuses over-4-MiB output and cleans scratch after stopping', async () => {
  const profile = profileFixture();
  const child = fakeChild();
  const spawnFn = spawnFake(child, () => child.stdout.write('x'.repeat(4 * 1024 * 1024 + 1)));
  await assert.rejects(runCodexAnalysis({ ...options, spawnFn }, config, { prepare: profile.prepare }), { code: 'agent_bad_output' });
  await missing(profile.root());
});

test('Codex rejects truncated JSONL on a zero exit and removes scratch after a spawn failure', async () => {
  const incomplete = profileFixture();
  const child = fakeChild();
  await assert.rejects(
    runCodexAnalysis(
      {
        ...options,
        spawnFn: spawnFake(child, () => {
          child.stdout.end(jsonl({ type: 'turn.started' }, { type: 'item.completed', item: { id: 'message', type: 'agent_message', text: '{}' } }));
          child.emit('close', 0);
        }),
      },
      config,
      { prepare: incomplete.prepare },
    ),
    { code: 'agent_bad_output' },
  );
  await missing(incomplete.root());
  const failed = profileFixture();
  await assert.rejects(
    runCodexAnalysis(
      {
        ...options,
        spawnFn: (() => {
          throw new Error('private token=fixture-secret');
        }) as SpawnFn,
      },
      config,
      { prepare: failed.prepare },
    ),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'agent_unavailable');
      assert.equal((error as { detail?: string }).detail?.includes('fixture-secret'), false);
      return true;
    },
  );
  await missing(failed.root());
});

test('Codex cancellation before launch never prepares credentials or starts a process', async () => {
  const controller = new AbortController();
  controller.abort();
  let prepared = false;
  await assert.rejects(
    runCodexAnalysis({ ...options, signal: controller.signal }, config, {
      prepare: async () => {
        prepared = true;
        throw new Error('must not prepare');
      },
    }),
    { code: 'agent_cancelled' },
  );
  assert.equal(prepared, false);
});

test('restricted Codex metadata removes advertised tools and unsafe cached instructions', () => {
  const metadata = {
    slug: 'wrong-model',
    display_name: 'must-not-copy',
    model_messages: { instructions_template: 'must-not-copy' },
    shell_type: 'bash',
    apply_patch_tool_type: 'freeform',
    experimental_supported_tools: ['exec', 'apply_patch', 'web_search'],
    input_modalities: ['text', 'image'],
    supported_reasoning_levels: [{ effort: 'high' }, { effort: 'unsafe' }],
    default_reasoning_level: 'high',
    context_window: 200_000,
    max_context_window: Number.MAX_VALUE,
  };
  const catalog = restrictedCodexCatalog('review-model', metadata);
  const model = catalog.models[0]!;
  assert.equal(model.slug, 'review-model');
  assert.equal(model.shell_type, 'disabled');
  assert.equal(model.apply_patch_tool_type, null);
  assert.deepEqual(model.experimental_supported_tools, []);
  assert.deepEqual(model.input_modalities, ['text']);
  assert.equal(model.supports_search_tool, false);
  assert.deepEqual(model.supported_reasoning_levels, [{ effort: 'high', description: 'high' }]);
  assert.equal(model.context_window, 200_000);
  assert.equal(model.max_context_window, null);
  assert.ok(!JSON.stringify(catalog).includes('must-not-copy'));
  assert.throws(() => restrictedCodexCatalog('--unsafe'));
});

test('Codex capability detection refuses incompatible versions or missing controls', () => {
  const help = '--json --ephemeral --ignore-rules --strict-config --output-schema --sandbox';
  const features = ['shell_tool', 'unified_exec', 'view_image', 'multi_agent', 'apps', 'plugins', 'hooks'].map((name) => `${name} stable false`).join('\n');
  validateCodexAnalysisVersion('codex-cli 0.164.0', help, features);
  validateCodexAnalysisVersion('codex 1.0.0', help, features);
  for (const [version, flags, gates] of [
    ['codex-cli 0.163.0', help, features],
    ['unknown', help, features],
    ['codex-cli 0.164.0', help.replace('--strict-config', ''), features],
    ['codex-cli 0.164.0', help, features.replace('hooks stable false', '')],
  ]) {
    assert.throws(() => validateCodexAnalysisVersion(version!, flags!, gates!), { code: 'agent_unavailable' });
  }
  const args = codexAnalysisArgs(config, {
    cwd: '/private/work',
    schema: '/private/schema.json',
    instructions: '/private/instructions.md',
    catalog: '/private/catalog.json',
    model: 'review-model',
  });
  assert.equal(args.at(-1), '-');
  assert.ok(args.includes('model_catalog_json="/private/catalog.json"'));
});
