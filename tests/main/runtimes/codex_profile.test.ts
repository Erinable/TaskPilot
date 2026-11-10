/** @module-tag integration */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';

import { prepareCodexProfile } from '../../../src/main/runtimes/codex_profile.ts';
import { tempDir } from '../../fixtures/temp_dir.ts';

const fixture = async (config: string, environment: NodeJS.ProcessEnv = {}) => {
  const home = await tempDir('taskpilot-codex-native-');
  const native = path.join(home, '.codex');
  const root = await tempDir('taskpilot-codex-private-');
  await fs.mkdir(native);
  await fs.writeFile(path.join(native, 'config.toml'), config);
  return { home, native, root, environment };
};

const mode = async (file: string) => (await fs.stat(file)).mode & 0o777;

test('Codex profile copies selected inference settings and credentials into a private home without user resources', async () => {
  const h = await fixture(
    [
      'model = "base-model"',
      'model_provider = "openai"',
      'model_reasoning_effort = "low"',
      'profile = "review"',
      'notify = ["must-not-run", "native-notification"]',
      'instructions = "must-not-copy-native-instructions"',
      'model_instructions_file = "/private/native-instructions.md"',
      '[profiles.review]',
      'model = "review-model"',
      'model_provider = "gateway"',
      'model_reasoning_effort = "high"',
      '[model_providers.gateway]',
      'name = "Private gateway"',
      'base_url = "https://gateway.invalid/v1"',
      'env_key = "GATEWAY_API_KEY"',
      'wire_api = "responses"',
      'query_params = { deployment = "review" }',
      'http_headers = { "x-fixture" = "static-header" }',
      'env_http_headers = { "x-tenant" = "GATEWAY_TENANT" }',
      'request_max_retries = 2',
      '[model_providers.unselected]',
      'name = "Must not copy"',
      'base_url = "https://unselected.invalid"',
      '[mcp_servers.fixture]',
      'command = "must-not-run"',
      '[hooks]',
      'startup = "must-not-run"',
      '[skills]',
      'include_instructions = true',
    ].join('\n'),
  );
  const credentials = '{"OPENAI_API_KEY":"fixture-auth-only"}';
  await fs.writeFile(path.join(h.native, 'auth.json'), credentials);
  await fs.mkdir(path.join(h.native, 'skills'));
  await fs.writeFile(path.join(h.native, 'skills', 'private.md'), 'must-not-copy-skill');
  await fs.writeFile(path.join(h.native, 'AGENTS.md'), 'must-not-copy-rules');
  const profile = await prepareCodexProfile(h.root, {
    home: h.home,
    environment: {
      HOME: '/must-not-use-home',
      CODEX_HOME: '/must-not-use-codex-home',
      GATEWAY_API_KEY: 'fixture-selected-key',
      GATEWAY_TENANT: 'fixture-tenant',
      OPENAI_API_KEY: 'fixture-openai-key',
      MUST_NOT_PASS: 'fixture-unselected-secret',
    },
  });
  assert.equal(profile.model, 'review-model');
  assert.equal(profile.provider, 'gateway');
  assert.equal(profile.thinking, 'high');
  assert.deepEqual(profile.environment, { OPENAI_API_KEY: 'fixture-openai-key', GATEWAY_API_KEY: 'fixture-selected-key', GATEWAY_TENANT: 'fixture-tenant' });
  const content = await fs.readFile(path.join(profile.directory, 'config.toml'), 'utf8');
  const projected = parseToml(content);
  assert.equal(projected.model, 'review-model');
  assert.equal(projected.model_provider, 'gateway');
  assert.equal(projected.model_reasoning_effort, 'high');
  assert.deepEqual(JSON.parse(JSON.stringify(projected.model_providers)), {
    gateway: {
      name: 'Private gateway',
      base_url: 'https://gateway.invalid/v1',
      env_key: 'GATEWAY_API_KEY',
      wire_api: 'responses',
      query_params: { deployment: 'review' },
      http_headers: { 'x-fixture': 'static-header' },
      env_http_headers: { 'x-tenant': 'GATEWAY_TENANT' },
      request_max_retries: 2,
    },
  });
  assert.ok(!content.includes('must-not-'));
  assert.equal(content.includes('fixture-selected-key'), false);
  assert.equal(content.includes('fixture-unselected-secret'), false);
  assert.deepEqual((await fs.readdir(profile.directory)).sort(), ['auth.json', 'config.toml']);
  assert.equal(await fs.readFile(path.join(profile.directory, 'auth.json'), 'utf8'), credentials);
  assert.equal(await fs.readFile(path.join(h.native, 'auth.json'), 'utf8'), credentials);
  assert.equal(await mode(profile.directory), 0o700);
  assert.equal(await mode(path.join(profile.directory, 'config.toml')), 0o600);
  assert.equal(await mode(path.join(profile.directory, 'auth.json')), 0o600);
});

test('Codex profile honors explicit CODEX_HOME without falling back to another credential store', async () => {
  const custom = await tempDir('taskpilot-custom-codex-');
  const root = await tempDir('taskpilot-custom-codex-private-');
  await fs.writeFile(path.join(custom, 'config.toml'), 'model = "custom-home-model"\n');
  await fs.writeFile(path.join(custom, 'auth.json'), '{"tokens":{"access_token":"fixture-access"}}');
  const profile = await prepareCodexProfile(root, { environment: { HOME: '/unused-home', CODEX_HOME: custom } });
  assert.equal(profile.model, 'custom-home-model');
  assert.equal(profile.provider, 'openai');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(profile.directory, 'auth.json'), 'utf8')), { tokens: { access_token: 'fixture-access' } });
});

test('Codex profile can use environment credentials with no auth file and picks visible cached model metadata', async () => {
  const h = await fixture('');
  await fs.writeFile(
    path.join(h.native, 'models_cache.json'),
    JSON.stringify({
      models: [
        { slug: 'hidden-model', priority: -1, visibility: 'hide' },
        { slug: 'later-model', priority: 10, visibility: 'list' },
        { slug: 'preferred-model', priority: 1, visibility: 'list', shell_type: 'must-be-replaced-in-catalog' },
      ],
    }),
  );
  const profile = await prepareCodexProfile(h.root, { home: h.home, environment: { CODEX_API_KEY: 'fixture-env-key' } });
  assert.equal(profile.model, 'preferred-model');
  assert.deepEqual(
    profile.metadata.map((entry) => entry.slug),
    ['preferred-model', 'later-model'],
  );
  assert.deepEqual(profile.environment, { CODEX_API_KEY: 'fixture-env-key' });
  assert.deepEqual(await fs.readdir(profile.directory), ['config.toml']);
});

for (const key of ['auth_provider_command', 'api_key_command']) {
  test(`Codex profile refuses selected provider executable credential configuration: ${key}`, async () => {
    const h = await fixture(`model = "review-model"\nmodel_provider = "gateway"\n[model_providers.gateway]\n${key} = "must-not-run"\n`);
    await assert.rejects(prepareCodexProfile(h.root, { home: h.home, environment: {} }), { code: 'agent_unavailable' });
    assert.deepEqual(await fs.readdir(h.root), []);
  });
}

for (const content of ['{ broken', '[]', 'null', '"secret"']) {
  test(`Codex profile rejects malformed credentials without copying their contents: ${content}`, async () => {
    const h = await fixture('model = "review-model"');
    await fs.writeFile(path.join(h.native, 'auth.json'), content);
    await assert.rejects(prepareCodexProfile(h.root, { home: h.home, environment: {} }), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'agent_unavailable');
      assert.ok(!(error as Error).message.includes(content));
      return true;
    });
    await assert.rejects(fs.access(path.join(h.root, 'codex', 'auth.json')), { code: 'ENOENT' });
    assert.equal(await fs.readFile(path.join(h.native, 'auth.json'), 'utf8'), content);
  });
}

for (const setting of ['env_key = "HOME"', 'env_http_headers = { "x-key" = "NODE_OPTIONS" }']) {
  test(`Codex credentials cannot overwrite the private runtime environment: ${setting}`, async () => {
    const h = await fixture(`model = "review-model"\nmodel_provider = "gateway"\n[model_providers.gateway]\n${setting}\n`);
    await assert.rejects(prepareCodexProfile(h.root, { home: h.home, environment: { HOME: '/must-not-pass', NODE_OPTIONS: '--import=must-not-load' } }), {
      code: 'agent_unavailable',
    });
    assert.deepEqual(await fs.readdir(h.root), []);
  });
}

test('Codex native unsupported thinking is not promoted to a runtime override', async () => {
  const h = await fixture('model = "review-model"\nmodel_reasoning_effort = "maximum"\n');
  const profile = await prepareCodexProfile(h.root, { home: h.home, environment: {} });
  assert.equal(profile.thinking, null);
  const projected = parseToml(await fs.readFile(path.join(profile.directory, 'config.toml'), 'utf8'));
  assert.equal(projected.model_reasoning_effort, undefined);
});

test('Codex refreshed credentials are written back privately only when explicitly synchronized', async () => {
  const h = await fixture('model = "review-model"\n');
  const source = path.join(h.native, 'auth.json');
  const original = '{"tokens":{"access_token":"fixture-old","refresh_token":"fixture-refresh"}}';
  const refreshed = '{"tokens":{"access_token":"fixture-new","refresh_token":"fixture-new-refresh"}}';
  await fs.writeFile(source, original, { mode: 0o600 });
  const profile = await prepareCodexProfile(h.root, { home: h.home, environment: {} });
  await fs.writeFile(path.join(profile.directory, 'auth.json'), refreshed);
  assert.equal(await fs.readFile(source, 'utf8'), original);
  await profile.syncCredentials();
  assert.equal(await fs.readFile(source, 'utf8'), refreshed);
  assert.equal(await mode(source), 0o600);
  assert.equal(await fs.readFile(path.join(h.native, 'config.toml'), 'utf8'), 'model = "review-model"\n');
});

test('Codex synchronization preserves externally updated credentials and rejects malformed refresh data', async () => {
  const h = await fixture('model = "review-model"\n');
  const source = path.join(h.native, 'auth.json');
  const original = '{"tokens":{"access_token":"fixture-old"}}';
  const external = '{"tokens":{"access_token":"fixture-external-login"}}';
  await fs.writeFile(source, original, { mode: 0o600 });
  const profile = await prepareCodexProfile(h.root, { home: h.home, environment: {} });
  await fs.writeFile(path.join(profile.directory, 'auth.json'), '{"tokens":{"access_token":"fixture-refreshed"}}');
  await fs.writeFile(source, external);
  await profile.syncCredentials();
  assert.equal(await fs.readFile(source, 'utf8'), external);
  const anotherRoot = await tempDir('taskpilot-codex-invalid-refresh-');
  const current = await prepareCodexProfile(anotherRoot, { home: h.home, environment: {} });
  for (const invalid of ['{ broken', '[]']) {
    await fs.writeFile(path.join(current.directory, 'auth.json'), invalid);
    await assert.rejects(current.syncCredentials());
    assert.equal(await fs.readFile(source, 'utf8'), external);
  }
});

test('concurrent Codex refreshes from one old credential snapshot cannot overwrite each other', async () => {
  const h = await fixture('model = "review-model"\n');
  const source = path.join(h.native, 'auth.json');
  await fs.writeFile(source, '{"tokens":{"access_token":"fixture-original"}}', { mode: 0o600 });
  const secondRoot = await tempDir('taskpilot-codex-second-refresh-');
  const [first, second] = await Promise.all([
    prepareCodexProfile(h.root, { home: h.home, environment: {} }),
    prepareCodexProfile(secondRoot, { home: h.home, environment: {} }),
  ]);
  const firstRefresh = '{"tokens":{"access_token":"fixture-first-refresh"}}';
  const secondRefresh = '{"tokens":{"access_token":"fixture-second-refresh"}}';
  await fs.writeFile(path.join(first.directory, 'auth.json'), firstRefresh);
  await fs.writeFile(path.join(second.directory, 'auth.json'), secondRefresh);
  await Promise.all([first.syncCredentials(), second.syncCredentials()]);
  assert.equal(await fs.readFile(source, 'utf8'), firstRefresh);
  assert.equal(await mode(source), 0o600);
});

test('environment-only Codex authentication never creates a native credential file during synchronization', async () => {
  const h = await fixture('model = "review-model"\n');
  const profile = await prepareCodexProfile(h.root, { home: h.home, environment: { OPENAI_API_KEY: 'fixture-env-only' } });
  await fs.writeFile(path.join(profile.directory, 'auth.json'), '{"tokens":{"access_token":"fixture-private-only"}}');
  await profile.syncCredentials();
  await assert.rejects(fs.access(path.join(h.native, 'auth.json')), { code: 'ENOENT' });
});

test('Codex native parse failures do not expose a credential source line or create a launch profile', async () => {
  const h = await fixture('model = "unterminated fixture-super-secret');
  await assert.rejects(prepareCodexProfile(h.root, { home: h.home, environment: {} }), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'agent_unavailable');
    assert.ok(!(error as Error).message.includes('fixture-super-secret'));
    return true;
  });
  assert.deepEqual(await fs.readdir(h.root), []);
});
