import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { tempDir } from '../../fixtures/temp_dir.ts';
import { restrictedCodexCatalog, writeCodexCatalog } from '../../../src/main/runtimes/codex_catalog.ts';

test('Codex analysis catalog preserves the real model ID while removing model-provided tools and instructions', () => {
  const catalog = restrictedCodexCatalog('provider/real-model', {
    slug: 'different-model',
    model_messages: { instructions_template: 'untrusted prompt' },
    base_instructions: 'untrusted base',
    apply_patch_tool_type: 'freeform',
    shell_type: 'unified_exec',
    experimental_supported_tools: ['clock', 'send_message_to_user_async'],
    supports_search_tool: true,
    tool_mode: 'code_mode_only',
    multi_agent_version: 'v2',
    use_responses_lite: true,
    api_key: 'do-not-copy-secret',
  });
  const model = catalog.models[0]!;
  assert.equal(model.slug, 'provider/real-model');
  assert.equal(model.shell_type, 'disabled');
  assert.equal(model.apply_patch_tool_type, null);
  assert.deepEqual(model.experimental_supported_tools, []);
  assert.equal(model.supports_search_tool, false);
  assert.equal(model.tool_mode, 'direct');
  assert.equal(model.multi_agent_version, null);
  assert.equal(model.use_responses_lite, false);
  assert.doesNotMatch(JSON.stringify(catalog), /untrusted|do-not-copy-secret|freeform|unified_exec|code_mode_only/);
});

test('Codex analysis catalog copies only validated inference capabilities', () => {
  const model = restrictedCodexCatalog('gpt-model', {
    supported_reasoning_levels: [{ effort: 'high', description: 'external text' }, { effort: 'high' }, { effort: 'xhigh' }, { effort: 'invented' }, null],
    default_reasoning_level: 'high',
    context_window: 128_000,
    max_context_window: 256_000,
    supports_reasoning_summary_parameter: true,
    support_verbosity: true,
  }).models[0]!;
  assert.deepEqual(model.supported_reasoning_levels, [
    { effort: 'high', description: 'high' },
    { effort: 'xhigh', description: 'xhigh' },
  ]);
  assert.equal(model.default_reasoning_level, 'high');
  assert.equal(model.context_window, 128_000);
  assert.equal(model.max_context_window, 256_000);
  assert.equal(model.support_verbosity, true);
  assert.equal(model.supports_reasoning_summary_parameter, true);
  const invalid = restrictedCodexCatalog('custom-model', {
    context_window: -1,
    max_context_window: 'infinite',
    default_reasoning_level: 'invented',
    supports_reasoning_summary_parameter: 'true',
  }).models[0]!;
  assert.equal(invalid.context_window, null);
  assert.equal(invalid.max_context_window, null);
  assert.equal(invalid.default_reasoning_level, null);
  assert.equal(invalid.supports_reasoning_summary_parameter, false);
});

test('Codex analysis requires an explicit model ID and writes one private catalog without replacing existing data', { tags: ['integration'] }, async () => {
  for (const model of ['', '../model', 'model\n--tools', 'model name', 'x'.repeat(201)]) assert.throws(() => restrictedCodexCatalog(model));
  const root = await tempDir('taskpilot-codex-catalog-');
  const privateRoot = path.join(root, 'private');
  const file = await writeCodexCatalog(privateRoot, 'gpt-model');
  assert.equal(file, path.join(privateRoot, 'taskpilot-model-catalog.json'));
  const original = await fs.readFile(file, 'utf8');
  assert.equal(JSON.parse(original).models[0].slug, 'gpt-model');
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  await assert.rejects(writeCodexCatalog(privateRoot, 'other-model'), { code: 'EEXIST' });
  assert.equal(await fs.readFile(file, 'utf8'), original);
  await assert.rejects(writeCodexCatalog('relative', 'gpt-model'));
});
