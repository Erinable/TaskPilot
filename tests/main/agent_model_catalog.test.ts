import { test, onTestFinished } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { readModelCatalog } from '../../src/main/agent_model_catalog.ts';
import { loadNativeConfig, parseNativeContent } from '../../src/main/cli_native_config.ts';

const home = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'taskpilot-native-models-'));
  onTestFinished(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
};
const configFile = async (root: string, relative: string, content: string) => {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
};

test('Pi native providers and settings form selectable provider/model IDs without credentials', async () => {
  const root = await home();
  await configFile(
    root,
    '.pi/agent/models.json',
    JSON.stringify({
      providers: {
        gateway: {
          api: 'openai-completions',
          apiKey: 'secret-model-catalog',
          baseUrl: 'https://private.example',
          models: [{ id: 'model-v1', name: 'Configured model', thinkingLevelMap: { high: 'high' } }],
        },
      },
    }),
  );
  await configFile(
    root,
    '.pi/agent/settings.json',
    JSON.stringify({ defaultProvider: 'gateway', defaultModel: 'model-v1', defaultThinkingLevel: 'high', extensions: ['do-not-run'] }),
  );
  const catalog = await readModelCatalog('pi', 'analysis', { home: root });
  assert.equal(catalog.defaultModel, 'gateway/model-v1');
  assert.equal(catalog.defaultThinking, 'high');
  assert.deepEqual(catalog.models, [{ id: 'gateway/model-v1', label: 'Configured model', provider: 'gateway', variants: ['high'], source: 'config' }]);
  assert.doesNotMatch(JSON.stringify(catalog), /secret-model-catalog|private\.example|do-not-run|apiKey|baseUrl/);
});

test('OpenCode JSONC provider variants and defaults preserve native selection IDs', async () => {
  const root = await home();
  await configFile(
    root,
    '.config/opencode/opencode.jsonc',
    `{
    // Native configuration may use comments and trailing commas.
    "model": "local/large", "provider": { "local": { "npm": "@ai-sdk/openai-compatible", "options": { "apiKey": "catalog-secret" }, "models": { "large": { "name": "Large model", "variants": { "high": {}, "low": {} } } } } },
  }`,
  );
  const catalog = await readModelCatalog('opencode', 'analysis', { home: root });
  assert.equal(catalog.defaultModel, 'local/large');
  assert.deepEqual(catalog.models[0], { id: 'local/large', label: 'Large model', provider: 'local', variants: ['high', 'low'], source: 'config' });
  assert.doesNotMatch(JSON.stringify(catalog), /catalog-secret|options|apiKey|npm/);
});

test('Grok picker uses configured catalog key instead of provider wire model', async () => {
  const root = await home();
  await configFile(
    root,
    '.grok/config.toml',
    `[models]\ndefault = "friendly-key"\n[model.friendly-key]\nmodel = "wire-model"\nname = "Friendly model"\nbase_url = "https://private.example"\napi_key = "secret-token"\n`,
  );
  const catalog = await readModelCatalog('grok', 'analysis', { home: root });
  assert.equal(catalog.defaultModel, 'friendly-key');
  assert.equal(catalog.models[0].id, 'friendly-key');
  assert.equal(catalog.models[0].label, 'Friendly model');
  assert.doesNotMatch(JSON.stringify(catalog), /secret-token|wire-model|private\.example/);
});

test('Codex custom provider does not pretend its first-party cache is a gateway catalog', async () => {
  const root = await home();
  await configFile(
    root,
    '.codex/config.toml',
    'model="gateway-model"\nmodel_provider="custom"\nmodel_reasoning_effort="high"\n[model_providers.custom]\nexperimental_bearer_token="secret"\n',
  );
  await configFile(root, '.codex/models_cache.json', JSON.stringify({ models: [{ slug: 'first-party-only', display_name: 'Not on gateway' }] }));
  const catalog = await readModelCatalog('codex', 'coding', { home: root });
  assert.deepEqual(
    catalog.models.map((model) => model.id),
    ['gateway-model'],
  );
  assert.equal(catalog.defaultModel, 'gateway-model');
  assert.doesNotMatch(JSON.stringify(catalog), /experimental_bearer_token|secret/);
});

test('Claude native model mappings are selectable and do not expose inference env', async () => {
  const root = await home();
  await configFile(
    root,
    '.claude/settings.json',
    JSON.stringify({
      model: 'native-default',
      env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'mapped-sonnet', ANTHROPIC_AUTH_TOKEN: 'secret', ANTHROPIC_BASE_URL: 'https://private.example' },
    }),
  );
  const catalog = await readModelCatalog('claude', 'analysis', { home: root, environment: {} });
  assert.equal(catalog.defaultModel, 'native-default');
  assert.ok(catalog.models.some((model) => model.id === 'mapped-sonnet'));
  assert.doesNotMatch(JSON.stringify(catalog), /AUTH_TOKEN|BASE_URL|secret|private\.example/);
});

test('malformed native config reports a generic problem without leaking secret source lines', () => {
  const result = parseNativeContent('api_key = "top-secret"\ninvalid = ', 'config.toml', 'toml');
  assert.equal(result.found, true);
  assert.deepEqual(result.data, {});
  assert.ok(result.issue);
  assert.doesNotMatch(result.issue, /top-secret|api_key|invalid =/);
});

test('OpenCode JSONC overrides merge provider model definitions without discarding other native models', async () => {
  const root = await home();
  await configFile(
    root,
    '.config/opencode/opencode.json',
    JSON.stringify({
      model: 'gateway/large',
      provider: { gateway: { options: { apiKey: 'private-key' }, models: { large: { name: 'Large', variants: { high: {} } }, small: { name: 'Small' } } } },
    }),
  );
  await configFile(root, '.config/opencode/opencode.jsonc', JSON.stringify({ provider: { gateway: { models: { large: { name: 'Large renamed' } } } } }));
  const catalog = await readModelCatalog('opencode', 'analysis', { home: root });
  assert.deepEqual(
    catalog.models.map(({ id, label, variants }) => ({ id, label, variants })),
    [
      { id: 'gateway/large', label: 'Large renamed', variants: ['high'] },
      { id: 'gateway/small', label: 'Small', variants: [] },
    ],
  );
  assert.equal(catalog.defaultModel, 'gateway/large');
  assert.doesNotMatch(JSON.stringify(catalog), /private-key|apiKey/);
});

test('Grok user model defaults retain managed allowlist and models from lower config layers', async () => {
  const root = await home();
  await configFile(
    root,
    '.grok/managed_config.toml',
    '[models]\ndefault="managed"\nallowed_models=["managed", "user"]\n[model.managed]\nmodel="managed-wire"\nname="Managed model"\n',
  );
  await configFile(root, '.grok/config.toml', '[models]\ndefault="user"\n[model.user]\nmodel="user-wire"\nname="User model"\n');
  const native = await loadNativeConfig('grok', { home: root });
  const catalog = await readModelCatalog('grok', 'analysis', { home: root });
  assert.deepEqual(native.data.models, { default: 'user', allowed_models: ['managed', 'user'] });
  assert.equal(catalog.defaultModel, 'user');
  assert.deepEqual(
    catalog.models.map((option) => option.id),
    ['managed', 'user'],
  );
});

test('analysis catalog follows the native PI_CODING_AGENT_DIR rather than a hard-coded home config', async () => {
  const root = await home();
  await configFile(root, '.pi/agent/settings.json', JSON.stringify({ defaultProvider: 'wrong', defaultModel: 'home' }));
  await configFile(root, 'custom-pi/settings.json', JSON.stringify({ defaultProvider: 'native', defaultModel: 'configured' }));
  const catalog = await readModelCatalog('pi', 'analysis', { environment: { HOME: root, PI_CODING_AGENT_DIR: path.join(root, 'custom-pi') } });
  assert.equal(catalog.defaultModel, 'native/configured');
  assert.deepEqual(
    catalog.models.map((option) => option.id),
    ['native/configured'],
  );
});

test('Grok allowed_models filters catalog keys and wire IDs without re-adding a blocked model', async () => {
  const root = await home();
  await configFile(
    root,
    '.grok/config.toml',
    '[models]\ndefault="blocked"\nallowed_models=["friendly", "wire-v?"]\n[model.friendly]\nmodel="other-wire"\n[model.alias]\nmodel="wire-v1"\n[model.blocked]\nmodel="blocked-wire"\n',
  );
  const catalog = await readModelCatalog('grok', 'analysis', { home: root });
  assert.deepEqual(
    catalog.models.map((option) => option.id),
    ['friendly', 'alias'],
  );
  assert.equal(catalog.defaultModel, 'blocked');
});
