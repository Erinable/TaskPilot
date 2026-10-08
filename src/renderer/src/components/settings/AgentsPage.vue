<script setup lang="ts">
import { computed, nextTick, onMounted, onUpdated, ref, watch } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import type { IconName } from '@/lib/icons.ts';
import { sameValue } from '@/lib/settings_model.ts';
import { useSettingsStore } from '@/stores/settings.ts';
import * as agentRuntime from '@shared/agent_runtime.ts';

const settings = useSettingsStore();
const query = ref('');
const matchedAgents = ref<agentRuntime.AgentId[]>([...agentRuntime.AGENT_IDS]);
const expanded = ref<Partial<Record<agentRuntime.AgentId, boolean>>>({});
const modelQueries = ref<Partial<Record<agentRuntime.AgentId, string>>>({});

const ROLES: Record<agentRuntime.AgentId, { title: string; description: string; icon: IconName }> = {
  'product-lead': { title: '需求规划', description: '澄清需求，拆分工作包', icon: 'list-checks' },
  architect: { title: '架构设计', description: '读取接口，裁决设计偏差', icon: 'blocks' },
  qa: { title: '质量审查', description: '审查改动与验收证据', icon: 'flask' },
  'release-manager': { title: '发布管理', description: '版本说明与发布清单', icon: 'rocket' },
  'env-steward': { title: '环境管家', description: '探测环境，规划初始化', icon: 'cpu' },
  tutor: { title: '编程导师', description: '解释步骤，提供操作指导', icon: 'sparkle' },
  'coding-agent': { title: '编码执行', description: '在独立账号中产出补丁', icon: 'terminal' },
};
const THINKING_LABELS: Record<agentRuntime.ThinkingLevel, string> = {
  default: '跟随模型',
  off: '关闭',
  minimal: '极简',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最高',
};
const GROUPS = [
  { id: 'analysis', title: '规划与审查', description: '受限分析 · 不开放工具', agents: agentRuntime.AGENT_IDS.filter((agent) => agent !== 'coding-agent') },
  { id: 'coding', title: '编码执行', description: '独立 OS 用户隔离', agents: ['coding-agent'] as agentRuntime.AgentId[] },
];
const config = (agent: agentRuntime.AgentId) => settings.preferencesDraft?.agents[agent];
const capability = (agent: agentRuntime.AgentId) => agentRuntime.CLI_OPTIONS.find((option) => option.id === config(agent)?.cli);
const runtime = (agent: agentRuntime.AgentId) => settings.agentStatus(agent);
const changed = (agent: agentRuntime.AgentId) =>
  !!settings.savedPreferences && !!config(agent) && !sameValue(settings.savedPreferences.agents[agent], config(agent));
const changedCount = computed(() => agentRuntime.AGENT_IDS.filter(changed).length);
const groups = computed(() =>
  GROUPS.map((group) => ({ ...group, agents: group.agents.filter((agent) => matchedAgents.value.includes(agent)) })).filter((group) => group.agents.length),
);

// Keep search results stable while editing a matching model or CLI.
watch(
  query,
  (value) => {
    const term = value.trim().toLowerCase();
    matchedAgents.value = agentRuntime.AGENT_IDS.filter((agent) => {
      const selected = config(agent);
      const saved = settings.savedPreferences?.agents[agent];
      const names = `${ROLES[agent].title} ${ROLES[agent].description} ${agentRuntime.AGENT_LABELS[agent]} ${capability(agent)?.label ?? ''} ${selected?.model ?? ''} ${saved?.model ?? ''}`;
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

const state = (agent: agentRuntime.AgentId) => {
  const status = runtime(agent);
  if (status) return { label: status.available ? '可用' : '需配置', tone: status.available ? 'available' : 'unavailable' };
  if (changed(agent)) return { label: '保存后检查', tone: 'pending' };
  return { label: settings.agentRuntimeLoading ? '检查中…' : '未检查', tone: 'unknown' };
};
const setCli = (agent: agentRuntime.AgentId, event: Event) => {
  if (event.target instanceof HTMLSelectElement) settings.setAgentCli(agent, event.target.value as agentRuntime.CliId);
};
const setThinking = (agent: agentRuntime.AgentId, event: Event) => {
  if (event.target instanceof HTMLSelectElement) settings.setAgentThinking(agent, event.target.value as agentRuntime.ThinkingLevel);
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
const modelOptions = (agent: agentRuntime.AgentId) => {
  const native = settings.modelsForAgent(agent)?.models ?? [];
  const current = config(agent)?.model;
  return current && !native.some((option) => option.id === current)
    ? [{ id: current, label: current, provider: null, variants: [], source: 'config' as const }, ...native]
    : native;
};
const defaultModelLabel = (agent: agentRuntime.AgentId) => {
  const native = settings.modelsForAgent(agent)?.defaultModel;
  return native ? `CLI 默认 · ${native}` : '使用 CLI 默认模型';
};
const matchesModelQuery = (agent: agentRuntime.AgentId, option: agentRuntime.CliModelOption) => {
  const term = (modelQueries.value[agent] ?? '').trim().toLowerCase();
  return !term || `${option.id} ${option.label} ${option.provider ?? ''}`.toLowerCase().includes(term);
};
const modelGroups = (agent: agentRuntime.AgentId) => {
  const groups = new Map<string, agentRuntime.CliModelOption[]>();
  for (const option of modelOptions(agent)) {
    if (!matchesModelQuery(agent, option)) continue;
    const label = option.provider ?? 'CLI 模型';
    const options = groups.get(label);
    if (options) options.push(option);
    else groups.set(label, [option]);
  }
  return [...groups].map(([label, options]) => ({ label, options }));
};
const syncModelFieldAccessibility = async () => {
  await nextTick();
  for (const agent of agentRuntime.AGENT_IDS) {
    const input = document.getElementById(`agent-${agent}-model`);
    if (!input) continue;
    const invalid = settings.agentFieldErrors[agent]?.field === 'model';
    input.setAttribute('aria-invalid', String(invalid));
    input.setAttribute('aria-describedby', ['agentModelHelp', invalid ? `agent-${agent}-error` : null].filter((id): id is string => id !== null).join(' '));
  }
};
onMounted(() => syncModelFieldAccessibility().catch((error) => console.error(error)));
onUpdated(() => syncModelFieldAccessibility().catch((error) => console.error(error)));
</script>

<template>
  <header class="settings-page-header agents-heading">
    <div>
      <h2>模型与智能体</h2>
      <p>按角色配置，保存后用于下一次运行。</p>
    </div>
    <span class="scope-badge">
      <AppIcon name="laptop" />
      本机设置
    </span>
  </header>

  <div class="agents-toolbar">
    <label class="agents-search">
      <AppIcon name="search" />
      <input id="agentSearch" v-model="query" type="search" autocomplete="off" placeholder="搜索角色、CLI 或模型" aria-label="搜索角色、CLI 或模型" />
    </label>
    <span class="agents-count" aria-live="polite">
      {{ matchedAgents.length }} 个角色
      <span v-if="changedCount" class="changes-count">· {{ changedCount }} 个已修改</span>
    </span>
    <button class="secondary-button small" type="button" :disabled="settings.agentRuntimeLoading || modelCatalogRefreshing" @click="refresh">
      <AppIcon
        :name="settings.agentRuntimeLoading || modelCatalogRefreshing ? 'spinner' : 'refresh'"
        :class="{ spin: settings.agentRuntimeLoading || modelCatalogRefreshing }"
      />
      {{ settings.agentRuntimeLoading || modelCatalogRefreshing ? '刷新中' : '刷新 CLI 与目录' }}
    </button>
  </div>
  <p v-if="settings.agentRuntimeError" class="agents-global-error" role="alert">
    <AppIcon name="alert" />
    {{ settings.agentRuntimeError }}
  </p>

  <div v-if="settings.preferencesDraft && matchedAgents.length" class="agents-table glass">
    <div class="agents-columns" aria-hidden="true">
      <span>角色</span>
      <span>CLI 运行器</span>
      <span>模型</span>
      <span>思考强度</span>
      <span></span>
    </div>
    <section v-for="group in groups" :key="group.id" :aria-labelledby="`agent-group-${group.id}`" class="agent-group">
      <header class="agent-group-heading">
        <strong :id="`agent-group-${group.id}`">{{ group.title }}</strong>
        <span>{{ group.description }}</span>
      </header>
      <section
        v-for="agent in group.agents"
        :key="agent"
        :data-agent="agent"
        class="agent-settings-card"
        :class="{ modified: changed(agent), invalid: settings.agentFieldErrors[agent] }"
        :aria-labelledby="`agent-${agent}-name`"
      >
        <div class="agent-row">
          <div class="agent-identity">
            <span class="agent-role-icon" :class="{ coding: agent === 'coding-agent' }"><AppIcon :name="ROLES[agent].icon" /></span>
            <div class="agent-name">
              <div class="agent-name-line">
                <h3 :id="`agent-${agent}-name`">{{ ROLES[agent].title }}</h3>
                <span v-if="changed(agent)" class="modified-dot" title="未保存的修改" aria-label="未保存的修改"></span>
              </div>
              <span>{{ agentRuntime.AGENT_LABELS[agent] }}</span>
            </div>
          </div>
          <div class="agent-field">
            <label class="field-label" :for="`agent-${agent}-cli`">{{ agentRuntime.AGENT_LABELS[agent] }} CLI</label>
            <div class="agent-select">
              <select
                :id="`agent-${agent}-cli`"
                :value="config(agent)?.cli"
                :disabled="settings.saving"
                :aria-invalid="settings.agentFieldErrors[agent]?.field === 'cli'"
                @change="setCli(agent, $event)"
              >
                <option v-for="option in agentRuntime.CLI_OPTIONS" :key="option.id" :value="option.id" :disabled="agent !== 'coding-agent' && !option.analysis">
                  {{ option.label }}{{ agent !== 'coding-agent' && !option.analysis ? ' · 仅编码' : '' }}
                </option>
              </select>
              <AppIcon name="chevron-down" />
            </div>
            <span class="runtime-state" :class="state(agent).tone" :title="runtime(agent)?.version ?? ''">
              <span class="runtime-dot" aria-hidden="true"></span>
              {{ state(agent).label }}
            </span>
          </div>
          <div class="agent-field agent-model-field">
            <label class="field-label" :for="`agent-${agent}-model`">{{ agentRuntime.AGENT_LABELS[agent] }} 模型</label>
            <el-select
              :id="`agent-${agent}-model`"
              :model-value="config(agent)?.model ?? ''"
              :disabled="settings.saving"
              :loading="settings.modelsLoadingForAgent(agent)"
              :aria-invalid="settings.agentFieldErrors[agent]?.field === 'model'"
              aria-describedby="agentModelHelp"
              class="agent-model-input"
              :popper-class="`agent-model-options agent-model-options-${agent}`"
              :placeholder="defaultModelLabel(agent)"
              filterable
              :allow-create="!modelOptions(agent).some((option) => matchesModelQuery(agent, option))"
              :filter-method="
                (value: string) => {
                  modelQueries[agent] = value;
                }
              "
              default-first-option
              clearable
              :fit-input-width="true"
              :reserve-keyword="false"
              @update:model-value="(value: string) => settings.setAgentModel(agent, value ?? '')"
              @visible-change="
                (visible: boolean) => {
                  if (!visible) modelQueries[agent] = '';
                }
              "
            >
              <el-option v-if="!modelQueries[agent]" value="" :label="defaultModelLabel(agent)" />
              <el-option-group v-for="modelGroup in modelGroups(agent)" :key="modelGroup.label" :label="modelGroup.label">
                <el-option v-for="option in modelGroup.options" :key="option.id" :value="option.id" :label="option.id">
                  <span class="model-option-name">{{ option.label }}</span>
                  <small v-if="option.label !== option.id" class="model-option-id">{{ option.id }}</small>
                </el-option>
              </el-option-group>
            </el-select>
            <span v-if="settings.modelsForAgent(agent)?.issues.length" class="model-catalog-note" :title="settings.modelsForAgent(agent)?.issues.join('\n')">
              目录不可用 · 可填写模型 ID
            </span>
          </div>
          <div class="agent-field agent-thinking-field">
            <label class="field-label" :for="`agent-${agent}-thinking`">{{ agentRuntime.AGENT_LABELS[agent] }} 思考强度</label>
            <div class="agent-select">
              <select
                :id="`agent-${agent}-thinking`"
                :value="config(agent)?.thinking"
                :disabled="settings.saving"
                :aria-invalid="settings.agentFieldErrors[agent]?.field === 'thinking'"
                @change="setThinking(agent, $event)"
              >
                <option v-for="level in capability(agent)?.thinking ?? []" :key="level" :value="level">{{ THINKING_LABELS[level] }}</option>
              </select>
              <AppIcon name="chevron-down" />
            </div>
          </div>
          <button
            class="agent-details-button"
            type="button"
            :aria-label="`${agentRuntime.AGENT_LABELS[agent]} 运行详情`"
            :aria-expanded="!!expanded[agent]"
            :aria-controls="`agent-${agent}-details`"
            @click="expanded[agent] = !expanded[agent]"
          >
            <AppIcon name="chevron-down" />
          </button>
        </div>
        <p v-if="settings.agentFieldErrors[agent]" :id="`agent-${agent}-error`" class="agent-row-message error" role="alert">
          <AppIcon name="alert" />
          {{ settings.agentFieldErrors[agent]?.message }}
        </p>
        <p v-if="settings.agentConfigNotices[agent]" class="agent-row-message warning" role="status">
          <AppIcon name="info" />
          {{ settings.agentConfigNotices[agent] }}
        </p>
        <div v-if="expanded[agent]" :id="`agent-${agent}-details`" class="agent-details">
          <div class="agent-details-copy">
            <p>{{ ROLES[agent].description }}。</p>
            <p v-if="capability(agent)?.note">{{ capability(agent)?.note }}</p>
            <p v-if="agent === 'coding-agent'">所选 CLI 须在 taskpilot-coder 账号内安装并登录；不会使用主账号的编码权限。</p>
            <p v-if="runtime(agent)?.version" class="runtime-version">{{ runtime(agent)?.command }} · {{ runtime(agent)?.version }}</p>
            <pre v-if="runtime(agent)?.reason" class="runtime-diagnostic">{{ runtime(agent)?.reason }}</pre>
            <p v-if="settings.modelsForAgent(agent)?.defaultModel">CLI 原生默认模型：{{ settings.modelsForAgent(agent)?.defaultModel }}</p>
            <p v-for="issue in settings.modelsForAgent(agent)?.issues ?? []" :key="issue" class="model-catalog-issue">{{ issue }}</p>
          </div>
          <button v-if="changed(agent)" class="secondary-button small" type="button" :disabled="settings.saving" @click="restore(agent)">
            <AppIcon name="undo" />
            还原此角色
          </button>
        </div>
      </section>
    </section>
  </div>
  <div v-else-if="settings.preferencesDraft" class="agents-empty glass" role="status">
    <AppIcon name="search" />
    <strong>没有匹配的角色</strong>
    <span>换一个关键词，或清除筛选。</span>
    <button class="secondary-button small" type="button" @click="query = ''">清除筛选</button>
  </div>
  <p v-else class="agents-loading" role="status">
    <AppIcon name="spinner" class="spin" />
    正在读取配置…
  </p>

  <div class="agents-help">
    <p id="agentModelHelp">
      <AppIcon name="info" />
      下拉框读取 CLI 自己的模型配置；选择默认项会跟随原生配置，也支持搜索或填写自定义 ID。
    </p>
    <details>
      <summary>模型填写与运行边界</summary>
      <div>
        <p>
          Pi / OpenCode 使用原生 provider/model 目录；Grok 使用 config.toml 的模型定义；Claude 显示配置映射和 CLI 别名，Codex
          使用自己的配置与适用的本地缓存。不会自动联网刷新模型列表。
        </p>
        <p>思考强度须由所选模型支持；“跟随模型”不覆盖 CLI 默认值。CLI 切换不自动替换模型 ID，请确认它适用于新的 CLI。</p>
        <p>Codex 仅用于编码；OpenCode 的受限分析支持 1.x。CLI 状态检查不会调用模型，修改后需保存才会检查新配置。</p>
      </div>
    </details>
  </div>
</template>

<style scoped>
.agents-heading {
  justify-content: space-between;
  margin-bottom: var(--space-5);
}
.agents-heading p {
  margin: var(--space-1) 0 0;
  color: var(--text-muted);
  font-size: var(--text-sm);
}
.agents-toolbar {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-bottom: var(--space-4);
}
.agents-search {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 300px;
  max-width: 100%;
  height: 36px;
  padding: 0 var(--space-3);
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-md);
  background: var(--glass-bg-strong);
}
.agents-search:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.agents-search .icon {
  color: var(--text-tertiary);
  width: 14px;
  height: 14px;
}
.agents-search input {
  min-width: 0;
  width: 100%;
  padding: 0;
  color: var(--text);
  background: transparent;
  border: 0;
  outline: 0;
  font: inherit;
}
.agents-count {
  margin-right: auto;
  color: var(--text-muted);
  font-size: var(--text-xs);
  white-space: nowrap;
}
.changes-count {
  color: var(--accent-strong);
}
.agents-table {
  overflow: hidden;
  border-radius: var(--radius-lg);
}
.agents-columns,
.agent-row {
  display: grid;
  grid-template-columns: minmax(175px, 1.2fr) minmax(135px, 0.9fr) minmax(175px, 1.5fr) minmax(104px, 0.65fr) 28px;
  gap: var(--space-3);
  align-items: start;
  padding: var(--space-3) var(--space-4);
}
.agent-row {
  min-height: 64px;
  padding-block: 6px;
}
.agents-columns {
  padding-block: 10px;
  color: var(--text-muted);
  font-size: var(--text-xs);
  background: var(--fill);
  border-bottom: 1px solid var(--line-soft);
}
.agent-group-heading {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-4);
  border-bottom: 1px solid var(--line-soft);
  background: var(--fill);
  font-size: var(--text-xs);
}
.agent-group-heading strong {
  color: var(--text-secondary);
  font-weight: 600;
}
.agent-group-heading span {
  color: var(--text-tertiary);
}
.agent-settings-card + .agent-settings-card,
.agent-group + .agent-group {
  border-top: 1px solid var(--line-soft);
}
.agent-settings-card {
  transition: background 0.15s var(--ease);
}
.agent-settings-card:hover {
  background: var(--fill);
}
.agent-settings-card.modified {
  background: var(--accent-soft);
}
.agent-settings-card.invalid {
  background: var(--danger-soft);
}
.agent-identity {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  padding-top: 3px;
}
.agent-role-icon {
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  width: 32px;
  height: 32px;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-md);
  color: var(--accent-strong);
  background: var(--glass-bg-strong);
}
.agent-role-icon.coding {
  color: var(--warning);
}
.agent-name {
  min-width: 0;
}
.agent-name-line {
  display: flex;
  align-items: center;
  gap: 6px;
}
.agent-name h3 {
  margin: 0;
  font-size: var(--text-sm);
  font-weight: 650;
}
.agent-name > span {
  display: block;
  margin-top: 2px;
  color: var(--text-muted);
  font-size: 11px;
  line-height: 1.4;
}
.modified-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--accent);
}
.agent-field {
  min-width: 0;
}
.field-label {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
.agent-select {
  position: relative;
}
.agent-select select {
  appearance: none;
  display: block;
  width: 100%;
  min-width: 0;
  height: 36px;
  padding: 0 27px 0 10px;
  color: var(--text);
  background: var(--glass-bg-strong);
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-md);
  font: inherit;
  cursor: pointer;
}
.agent-select select:hover {
  border-color: var(--text-tertiary);
}
.agent-select select:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.agent-select select:disabled {
  opacity: 0.6;
  cursor: default;
}
.agent-select select[aria-invalid='true'] {
  border-color: var(--danger);
}
.agent-select > .icon {
  position: absolute;
  right: 9px;
  top: 11px;
  width: 14px;
  height: 14px;
  color: var(--text-tertiary);
  pointer-events: none;
}
.agent-model-field :deep(.el-select) {
  width: 100%;
}
.agent-model-field :deep(.el-select__wrapper) {
  min-height: 36px;
  padding: 0 10px;
  background: var(--glass-bg-strong);
  border-radius: var(--radius-md);
  box-shadow: 0 0 0 1px var(--line-soft) inset;
}
.agent-model-field :deep(.el-select__wrapper.is-focused) {
  box-shadow:
    0 0 0 1px var(--accent) inset,
    0 0 0 3px var(--accent-soft);
}
.agent-model-field :deep(.el-select__input),
.agent-model-field :deep(.el-select__selected-item) {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}
.agent-model-field :deep(.el-select__wrapper:has([aria-invalid='true'])) {
  box-shadow: 0 0 0 1px var(--danger) inset;
}
:global(.agent-model-options .el-select-dropdown__item) {
  height: auto;
  min-height: 36px;
  padding-top: 6px;
  padding-bottom: 6px;
  line-height: 18px;
}
.model-option-name {
  display: block;
  font-size: var(--text-xs);
}
.model-option-id {
  display: block;
  color: var(--text-muted);
  font: 11px var(--font-mono);
}
.model-catalog-note {
  display: block;
  margin-top: 3px;
  color: var(--warning);
  font-size: 11px;
}
.model-catalog-issue {
  color: var(--warning);
}
.runtime-state {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-top: 3px;
  color: var(--text-tertiary);
  font-size: 11px;
  line-height: 13px;
}
.runtime-state.available {
  color: var(--success);
}
.runtime-state.unavailable {
  color: var(--warning);
}
.runtime-state.pending {
  color: var(--accent-strong);
}
.runtime-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
}
.agent-details-button {
  display: grid;
  place-items: center;
  width: 28px;
  height: 36px;
  color: var(--text-muted);
  border-radius: var(--radius-sm);
}
.agent-details-button:hover {
  color: var(--text);
  background: var(--fill-hover);
}
.agent-details-button .icon {
  width: 14px;
  height: 14px;
  transition: transform 0.15s var(--ease);
}
.agent-details-button[aria-expanded='true'] .icon {
  transform: rotate(180deg);
}
.agent-details {
  display: flex;
  align-items: flex-start;
  gap: var(--space-4);
  padding: 0 var(--space-4) var(--space-3) 58px;
}
.agent-details-copy {
  min-width: 0;
  flex: 1;
  color: var(--text-muted);
  font-size: var(--text-xs);
}
.agent-details-copy p {
  margin: 0 0 var(--space-1);
}
.runtime-version {
  font-family: var(--font-mono);
}
.runtime-diagnostic {
  margin: var(--space-2) 0 0;
  padding: var(--space-2) var(--space-3);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  border-radius: var(--radius-sm);
  background: var(--fill);
  color: var(--warning);
  font: 11px/1.6 var(--font-mono);
}
.agent-row-message,
.agents-global-error {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  margin: 0;
  padding: 0 var(--space-4) var(--space-3) 58px;
  font-size: var(--text-xs);
}
.agent-row-message .icon,
.agents-global-error .icon {
  margin-top: 2px;
  width: 14px;
  height: 14px;
}
.agent-row-message.error,
.agents-global-error {
  color: var(--danger);
}
.agent-row-message.warning {
  color: var(--warning);
}
.agents-global-error {
  padding: 0 0 var(--space-3);
}
.agents-empty {
  display: grid;
  justify-items: center;
  gap: var(--space-2);
  padding: var(--space-10) var(--space-5);
  border-radius: var(--radius-lg);
  color: var(--text-muted);
}
.agents-empty strong {
  color: var(--text);
}
.agents-empty > .icon {
  width: 24px;
  height: 24px;
  color: var(--text-tertiary);
}
.agents-loading {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--text-muted);
}
.agents-help {
  margin-top: var(--space-3);
  color: var(--text-muted);
  font-size: var(--text-xs);
}
.agents-help > p {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  margin: 0;
}
.agents-help > p .icon {
  width: 14px;
  height: 14px;
  margin-top: 2px;
  color: var(--text-tertiary);
}
.agents-help details {
  margin: var(--space-2) 0 0 22px;
}
.agents-help summary {
  width: fit-content;
  cursor: pointer;
  color: var(--text-secondary);
}
.agents-help details p {
  margin: var(--space-2) 0 0;
  line-height: 1.7;
}
@container agent-settings (max-width: 700px) {
  .agents-heading {
    align-items: flex-start;
  }
  .agents-heading .scope-badge {
    white-space: nowrap;
  }
  .agents-toolbar {
    flex-wrap: wrap;
  }
  .agents-search {
    width: 100%;
  }
  .agents-columns {
    display: none;
  }
  .agent-row {
    position: relative;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: var(--space-3);
  }
  .agent-identity {
    grid-column: 1 / -1;
  }
  .agent-model-field {
    grid-column: 1 / -1;
    grid-row: 3;
  }
  .agent-details-button {
    position: absolute;
    top: 12px;
    right: 16px;
  }
  .field-label {
    position: static;
    display: block;
    width: auto;
    height: auto;
    clip-path: none;
    margin-bottom: var(--space-1);
    color: var(--text-muted);
    font-size: 11px;
    white-space: normal;
  }
  .agent-details {
    padding-left: var(--space-4);
    flex-wrap: wrap;
  }
  .agent-row-message {
    padding-left: var(--space-4);
  }
}
</style>
