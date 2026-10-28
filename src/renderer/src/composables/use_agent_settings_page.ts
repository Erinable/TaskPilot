import { computed, onMounted, ref, watch } from 'vue';
import type { IconName } from '@/lib/icons.ts';

import { sameValue } from '@/lib/settings_model.ts';
import { useSettingsStore } from '@/stores/settings.ts';
import * as agentRuntime from '@shared/agent_runtime.ts';

export const AGENT_ROLES: Record<agentRuntime.AgentId, { title: string; description: string; icon: IconName }> = {
  'product-lead': { title: '需求规划', description: '澄清需求，拆分工作包', icon: 'list-checks' },
  architect: { title: '架构设计', description: '读取接口，裁决设计偏差', icon: 'blocks' },
  qa: { title: '质量审查', description: '审查改动与验收证据', icon: 'flask' },
  'release-manager': { title: '发布管理', description: '版本说明与发布清单', icon: 'rocket' },
  'env-steward': { title: '环境管家', description: '探测环境，规划初始化', icon: 'cpu' },
  tutor: { title: '编程导师', description: '解释步骤，提供操作指导', icon: 'sparkle' },
  'coding-agent': { title: '编码执行', description: '在隔离环境中产出补丁', icon: 'terminal' },
};

export const THINKING_LABELS: Record<agentRuntime.ThinkingLevel, string> = {
  default: '跟随模型',
  off: '关闭',
  minimal: '极简',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最高',
};

const AGENT_GROUPS = [
  { id: 'analysis', title: '规划与审查', description: '受限分析 · 不开放工具', agents: agentRuntime.AGENT_IDS.filter((agent) => agent !== 'coding-agent') },
  { id: 'coding', title: '编码执行', description: '沙箱或独立账号隔离', agents: ['coding-agent'] as agentRuntime.AgentId[] },
];

export const useAgentSettingsPage = () => {
  const settings = useSettingsStore();
  const query = ref('');
  const matchedAgents = ref<agentRuntime.AgentId[]>([...agentRuntime.AGENT_IDS]);
  const expanded = ref<Partial<Record<agentRuntime.AgentId, boolean>>>({});
  const toggleExpanded = (agent: agentRuntime.AgentId) => {
    expanded.value[agent] = !expanded.value[agent];
  };
  const config = (agent: agentRuntime.AgentId) => settings.preferencesDraft?.agents[agent];
  const capability = (agent: agentRuntime.AgentId) => agentRuntime.CLI_OPTIONS.find((option) => option.id === config(agent)?.cli);
  const runtime = (agent: agentRuntime.AgentId) => settings.agentStatus(agent);
  const changed = (agent: agentRuntime.AgentId) =>
    !!settings.savedPreferences && !!config(agent) && !sameValue(settings.savedPreferences.agents[agent], config(agent));
  const changedCount = computed(() => agentRuntime.AGENT_IDS.filter(changed).length);
  const groups = computed(() =>
    AGENT_GROUPS.map((group) => ({ ...group, agents: group.agents.filter((agent) => matchedAgents.value.includes(agent)) })).filter(
      (group) => group.agents.length,
    ),
  );

  // Keep search results stable while editing a matching model or CLI.
  watch(
    query,
    (value) => {
      const term = value.trim().toLowerCase();
      matchedAgents.value = agentRuntime.AGENT_IDS.filter((agent) => {
        const selected = config(agent);
        const saved = settings.savedPreferences?.agents[agent];
        const names = `${AGENT_ROLES[agent].title} ${AGENT_ROLES[agent].description} ${agentRuntime.AGENT_LABELS[agent]} ${capability(agent)?.label ?? ''} ${selected?.model ?? ''} ${saved?.model ?? ''}`;
        return !term || names.toLowerCase().includes(term);
      });
    },
    { flush: 'sync' },
  );
  watch(
    () => settings.agentFieldErrors,
    (errors) => {
      if (Object.values(errors).some(Boolean)) query.value = '';
    },
    { deep: true },
  );

  const state = (agent: agentRuntime.AgentId): { label: string; tone: 'available' | 'unavailable' | 'pending' | 'unknown' } => {
    const status = runtime(agent);
    if (status) return { label: status.available ? '可用' : '需配置', tone: status.available ? 'available' : 'unavailable' };
    if (changed(agent)) return { label: '保存后检查', tone: 'pending' };
    return { label: settings.agentRuntimeLoading ? '检查中…' : '未检查', tone: 'unknown' };
  };
  const restore = (agent: agentRuntime.AgentId) => {
    const saved = settings.savedPreferences?.agents[agent];
    if (!saved) return;
    settings.setAgentCli(agent, saved.cli);
    settings.setAgentModel(agent, saved.model);
    settings.setAgentThinking(agent, saved.thinking);
  };
  const modelCatalogRefreshing = computed(() => agentRuntime.AGENT_IDS.some((agent) => settings.modelsLoadingForAgent(agent)));
  const refresh = async () => {
    const loaded = new Set<string>();
    await Promise.all([
      settings.refreshAgentRuntimes(),
      ...agentRuntime.AGENT_IDS.map(async (agent) => {
        const cli = config(agent)?.cli;
        const key = `${agent === 'coding-agent' ? 'coding' : 'analysis'}:${cli}`;
        if (!cli || loaded.has(key)) return;
        loaded.add(key);
        await settings.loadAgentModels(agent, true);
      }),
    ]);
  };
  onMounted(() => {
    for (const agent of agentRuntime.AGENT_IDS) settings.loadAgentModels(agent).catch((error) => console.error(error));
  });

  return {
    settings,
    query,
    matchedAgents,
    expanded,
    toggleExpanded,
    groups,
    config,
    capability,
    runtime,
    changed,
    changedCount,
    state,
    restore,
    modelCatalogRefreshing,
    refresh,
    roles: AGENT_ROLES,
    thinkingLabels: THINKING_LABELS,
  };
};
