import { ref, type Ref } from 'vue';

import { describeError } from '@/lib/errors.ts';
import { sameValue } from '@/lib/settings_model.ts';
import { call } from '@/lib/ipc.ts';
import type * as agentRuntime from '@shared/agent_runtime.ts';
import { CLI_OPTIONS } from '@shared/agent_runtime.ts';
import type * as settingsTypes from '@shared/ipc/settings.ts';

export const useAgentSettings = (preferencesDraft: Ref<settingsTypes.PreferencesInput | null>) => {
  const agentRuntimes = ref<agentRuntime.AgentRuntimeStatus[]>([]);
  const agentRuntimeLoading = ref(false);
  const agentRuntimeError = ref<string | null>(null);
  const agentConfigNotices = ref<Partial<Record<agentRuntime.AgentId, string>>>({});
  const agentFieldErrors = ref<Partial<Record<agentRuntime.AgentId, { field: 'cli' | 'model' | 'thinking'; message: string }>>>({});
  let agentRuntimeGeneration = 0;
  const modelCatalogs = ref<Record<string, agentRuntime.CliModelCatalog>>({});
  const modelCatalogLoading = ref<Record<string, boolean>>({});
  const modelCatalogRequests = new Map<string, Promise<void>>();
  const modelCatalogGenerations = new Map<string, number>();
  const modelScope = (agent: agentRuntime.AgentId): agentRuntime.CliModelScope => (agent === 'coding-agent' ? 'coding' : 'analysis');
  const modelsForAgent = (agent: agentRuntime.AgentId) => {
    const cli = preferencesDraft.value?.agents[agent].cli;
    return cli ? modelCatalogs.value[`${modelScope(agent)}:${cli}`] : undefined;
  };
  const modelsLoadingForAgent = (agent: agentRuntime.AgentId) => {
    const cli = preferencesDraft.value?.agents[agent].cli;
    return cli ? modelCatalogLoading.value[`${modelScope(agent)}:${cli}`] === true : false;
  };
  const loadAgentModels = async (agent: agentRuntime.AgentId, refresh = false) => {
    const cli = preferencesDraft.value?.agents[agent].cli;
    if (!cli) return;
    const scope = modelScope(agent);
    const key = `${scope}:${cli}`;
    if (!refresh && modelCatalogs.value[key]) return;
    const current = modelCatalogRequests.get(key);
    if (!refresh && current) return current;
    const generation = (modelCatalogGenerations.get(key) ?? 0) + 1;
    modelCatalogGenerations.set(key, generation);
    modelCatalogLoading.value[key] = true;
    const reading = (async () => {
      try {
        const catalog = await call(window.taskpilot.agent.models({ cli, scope, refresh }));
        if (modelCatalogGenerations.get(key) === generation) modelCatalogs.value[key] = catalog;
      } catch (error) {
        if (modelCatalogGenerations.get(key) === generation)
          modelCatalogs.value[key] = {
            ...(modelCatalogs.value[key] ?? { cli, scope, models: [], defaultModel: null, defaultThinking: null }),
            issues: [`读取 CLI 模型目录失败：${describeError(error)}`],
          };
      } finally {
        if (modelCatalogGenerations.get(key) === generation) {
          modelCatalogLoading.value[key] = false;
          modelCatalogRequests.delete(key);
        }
      }
    })();
    modelCatalogRequests.set(key, reading);
    return reading;
  };
  const refreshAgentRuntimes = async () => {
    const generation = ++agentRuntimeGeneration;
    agentRuntimeLoading.value = true;
    agentRuntimeError.value = null;
    try {
      const statuses = await call(window.taskpilot.agent.runtimes());
      if (generation === agentRuntimeGeneration) agentRuntimes.value = statuses;
    } catch (error) {
      if (generation === agentRuntimeGeneration) agentRuntimeError.value = describeError(error);
    } finally {
      if (generation === agentRuntimeGeneration) agentRuntimeLoading.value = false;
    }
  };
  const setAgentCli = (agent: agentRuntime.AgentId, cli: agentRuntime.CliId) => {
    const current = preferencesDraft.value?.agents[agent];
    const option = CLI_OPTIONS.find((entry) => entry.id === cli);
    if (!current || !option || (agent !== 'coding-agent' && !option.analysis)) return;
    const thinking = option.thinking.includes(current.thinking) ? current.thinking : 'default';
    delete agentFieldErrors.value[agent];
    preferencesDraft.value!.agents[agent] = { ...current, cli, thinking };
    agentConfigNotices.value[agent] = thinking === current.thinking ? '' : `切换到 ${option.label} 后不支持原思考强度，已重置为默认。`;
    loadAgentModels(agent).catch((error) => console.error(error));
  };
  const setAgentModel = (agent: agentRuntime.AgentId, modelName: string) => {
    if (!preferencesDraft.value) return;
    preferencesDraft.value.agents[agent].model = modelName;
    delete agentFieldErrors.value[agent];
  };
  const setAgentThinking = (agent: agentRuntime.AgentId, thinking: agentRuntime.ThinkingLevel) => {
    const current = preferencesDraft.value?.agents[agent];
    const option = current && CLI_OPTIONS.find((entry) => entry.id === current.cli);
    if (!current || !option?.thinking.includes(thinking)) return;
    delete agentFieldErrors.value[agent];
    preferencesDraft.value!.agents[agent] = { ...current, thinking };
    agentConfigNotices.value[agent] = '';
  };
  const agentStatus = (agent: agentRuntime.AgentId) => {
    const status = agentRuntimes.value.find((entry) => entry.agent === agent);
    const draft = preferencesDraft.value?.agents[agent];
    return status && draft && sameValue(status.config, draft) ? status : undefined;
  };

  return {
    agentRuntimes,
    agentRuntimeLoading,
    agentRuntimeError,
    agentConfigNotices,
    agentFieldErrors,
    refreshAgentRuntimes,
    modelCatalogs,
    modelCatalogLoading,
    modelsForAgent,
    modelsLoadingForAgent,
    loadAgentModels,
    setAgentCli,
    setAgentModel,
    setAgentThinking,
    agentStatus,
  };
};
