// @vitest-environment happy-dom
// The agent settings slice: per-CLI model catalogs are read once and
// shared, a refresh drops an older read's answer, and switching a role's CLI
// resets only what the new CLI cannot do.
import { beforeEach, expect, test } from 'vitest';
import { ref } from 'vue';
import type { Ref } from 'vue';

import { useAgentSettings } from '@/stores/settings_agents.ts';
import { installFakeApi, ok } from '../ipc_fakes.ts';
import { preferences } from '../settings_fakes.ts';
import type * as agentRuntime from '@shared/agent_runtime.ts';
import type { IpcResult } from '@shared/ipc/envelope.ts';
import type * as settingsTypes from '@shared/ipc/settings.ts';

const catalog = (cli: agentRuntime.CliId, model: string): agentRuntime.CliModelCatalog => ({
  cli,
  scope: 'analysis',
  models: [{ id: model, label: model, provider: null, variants: [], source: 'config' }],
  defaultModel: model,
  defaultThinking: null,
  issues: [],
});

let api: ReturnType<typeof installFakeApi>;
let draft: Ref<settingsTypes.PreferencesInput | null>;

beforeEach(() => {
  api = installFakeApi({ agent: { models: (request) => ok(catalog(request.cli, `${request.cli}-model`)) } });
  draft = ref<settingsTypes.PreferencesInput | null>(preferences());
});

test('two roles on the same CLI share one catalog read', async () => {
  const agents = useAgentSettings(draft);
  await Promise.all([agents.loadAgentModels('product-lead'), agents.loadAgentModels('qa')]);
  expect(api.agent.models).toHaveBeenCalledTimes(1);
  expect(agents.modelsForAgent('qa')?.defaultModel).toBe('claude-model');
  await agents.loadAgentModels('architect');
  expect(api.agent.models).toHaveBeenCalledTimes(1);
});

test('a refresh started during a read wins, and the older answer is dropped', async () => {
  const held = Promise.withResolvers<IpcResult<agentRuntime.CliModelCatalog>>();
  api.agent.models.mockReturnValueOnce(held.promise);
  const agents = useAgentSettings(draft);
  const first = agents.loadAgentModels('qa');
  api.agent.models.mockReturnValueOnce(ok(catalog('claude', 'fresh')));
  await agents.loadAgentModels('qa', true);
  held.resolve({ ok: true, data: catalog('claude', 'stale') });
  await first;
  expect(agents.modelsForAgent('qa')?.defaultModel).toBe('fresh');
  expect(agents.modelsLoadingForAgent('qa')).toBe(false);
});

test('a failed read keeps what was shown and adds the reason as an issue', async () => {
  const agents = useAgentSettings(draft);
  await agents.loadAgentModels('qa');
  api.agent.models.mockReturnValueOnce(Promise.resolve({ ok: false, error: { code: 'unknown', message: 'CLI crashed' } }));
  await agents.loadAgentModels('qa', true);
  expect(agents.modelsForAgent('qa')?.defaultModel).toBe('claude-model');
  expect(agents.modelsForAgent('qa')?.issues).toEqual(['读取 CLI 模型目录失败：CLI crashed']);
});

test('switching CLI keeps a thinking level the new CLI supports and resets one it does not', () => {
  const agents = useAgentSettings(draft);
  draft.value!.agents.qa.thinking = 'high';
  agents.setAgentCli('qa', 'grok');
  expect(draft.value!.agents.qa).toMatchObject({ cli: 'grok', thinking: 'high' });
  expect(agents.agentConfigNotices.value.qa).toBe('');

  draft.value!.agents.qa.thinking = 'max';
  agents.setAgentCli('qa', 'claude');
  agents.setAgentCli('qa', 'grok');
  expect(draft.value!.agents.qa.thinking).toBe('default');
  expect(agents.agentConfigNotices.value.qa).toContain('已重置为默认');
});

test('an analysis role cannot pick a coding-only CLI; the coding agent can', () => {
  const agents = useAgentSettings(draft);
  const before = draft.value!.agents.qa.cli;
  agents.setAgentCli('qa', 'codex');
  expect(draft.value!.agents.qa.cli).toBe(before);
  agents.setAgentCli('coding-agent', 'codex');
  expect(draft.value!.agents['coding-agent'].cli).toBe('codex');
});

test('editing a role clears its field error', () => {
  const agents = useAgentSettings(draft);
  agents.agentFieldErrors.value.qa = { field: 'model', message: 'Invalid model identifier' };
  agents.setAgentModel('qa', 'provider/model');
  expect(agents.agentFieldErrors.value.qa).toBeUndefined();
  expect(draft.value!.agents.qa.model).toBe('provider/model');
});
