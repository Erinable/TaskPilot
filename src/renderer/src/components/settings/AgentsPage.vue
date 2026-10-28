<script setup lang="ts">
import AppIcon from '@/components/AppIcon.vue';
import CodingIsolation from './CodingIsolation.vue';
import AgentConfigRow from './AgentConfigRow.vue';
import { useAgentSettingsPage } from '@/composables/use_agent_settings_page.ts';

const {
  settings,
  query,
  matchedAgents,
  groups,
  expanded,
  toggleExpanded,
  config,
  capability,
  runtime,
  changed,
  changedCount,
  state,
  restore,
  modelCatalogRefreshing,
  refresh,
  roles,
  thinkingLabels,
} = useAgentSettingsPage();
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
      <AgentConfigRow
        v-for="agent in group.agents"
        :key="agent"
        :agent="agent"
        :title="roles[agent].title"
        :description="roles[agent].description"
        :icon="roles[agent].icon"
        :config="config(agent)!"
        :expanded="!!expanded[agent]"
        :capability="capability(agent)"
        :runtime-status="runtime(agent)"
        :state="state(agent)"
        :catalog="settings.modelsForAgent(agent)"
        :loading="settings.modelsLoadingForAgent(agent)"
        :changed="changed(agent)"
        :error="settings.agentFieldErrors[agent]"
        :notice="settings.agentConfigNotices[agent]"
        :saving="settings.saving"
        :thinking-labels="thinkingLabels"
        :coding-isolation="settings.preferencesDraft?.coding?.isolation"
        @cli="settings.setAgentCli(agent, $event)"
        @model="settings.setAgentModel(agent, $event)"
        @thinking="settings.setAgentThinking(agent, $event)"
        @restore="restore(agent)"
        @toggle="toggleExpanded(agent)"
      />
      <CodingIsolation v-if="group.id === 'coding'" />
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
.agents-columns {
  display: grid;
  grid-template-columns: minmax(175px, 1.2fr) minmax(135px, 0.9fr) minmax(175px, 1.5fr) minmax(104px, 0.65fr) 28px;
  gap: var(--space-3);
  align-items: start;
  padding: var(--space-3) var(--space-4);
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
.agent-group + .agent-group {
  border-top: 1px solid var(--line-soft);
}
.agents-global-error {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  margin: 0;
  padding: 0 0 var(--space-3);
  color: var(--danger);
  font-size: var(--text-xs);
}
.agents-global-error .icon {
  margin-top: 2px;
  width: 14px;
  height: 14px;
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
}
</style>
