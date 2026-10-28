<script setup lang="ts">
import AppIcon from '@/components/AppIcon.vue';
import type { IconName } from '@/lib/icons.ts';
import * as agentRuntime from '@shared/agent_runtime.ts';
import AgentModelPicker from './AgentModelPicker.vue';

defineProps<{
  agent: agentRuntime.AgentId;
  title: string;
  description: string;
  icon: IconName;
  config: agentRuntime.AgentRuntimeConfig;
  capability: (typeof agentRuntime.CLI_OPTIONS)[number] | undefined;
  runtimeStatus: agentRuntime.AgentRuntimeStatus | undefined;
  state: { label: string; tone: 'available' | 'unavailable' | 'pending' | 'unknown' };
  catalog: agentRuntime.CliModelCatalog | undefined;
  loading: boolean;
  expanded: boolean;
  changed: boolean;
  error: { field: 'cli' | 'model' | 'thinking'; message: string } | undefined;
  notice: string | undefined;
  saving: boolean;
  thinkingLabels: Record<agentRuntime.ThinkingLevel, string>;
  codingIsolation: 'sandbox' | 'separate-user' | undefined;
}>();
const emit = defineEmits<{
  cli: [value: agentRuntime.CliId];
  model: [value: string];
  thinking: [value: agentRuntime.ThinkingLevel];
  restore: [];
  toggle: [];
}>();

const setSelectValue = (event: Event, kind: 'cli' | 'thinking') => {
  if (!(event.target instanceof HTMLSelectElement)) return;
  if (kind === 'cli') emit('cli', event.target.value as agentRuntime.CliId);
  else emit('thinking', event.target.value as agentRuntime.ThinkingLevel);
};
</script>

<template>
  <section :data-agent="agent" class="agent-settings-card" :class="{ modified: changed, invalid: error }" :aria-labelledby="`agent-${agent}-name`">
    <div class="agent-row">
      <div class="agent-identity">
        <span class="agent-role-icon" :class="{ coding: agent === 'coding-agent' }"><AppIcon :name="icon" /></span>
        <div class="agent-name">
          <div class="agent-name-line">
            <h3 :id="`agent-${agent}-name`">{{ title }}</h3>
            <span v-if="changed" class="modified-dot" title="未保存的修改" aria-label="未保存的修改"></span>
          </div>
          <span>{{ agentRuntime.AGENT_LABELS[agent] }}</span>
        </div>
      </div>
      <div class="agent-field">
        <label class="field-label" :for="`agent-${agent}-cli`">{{ agentRuntime.AGENT_LABELS[agent] }} CLI</label>
        <div class="agent-select">
          <select
            :id="`agent-${agent}-cli`"
            :value="config.cli"
            :disabled="saving"
            :aria-invalid="error?.field === 'cli'"
            @change="setSelectValue($event, 'cli')"
          >
            <option v-for="option in agentRuntime.CLI_OPTIONS" :key="option.id" :value="option.id" :disabled="agent !== 'coding-agent' && !option.analysis">
              {{ option.label }}{{ agent !== 'coding-agent' && !option.analysis ? ' · 仅编码' : '' }}
            </option>
          </select>
          <AppIcon name="chevron-down" />
        </div>
        <span class="runtime-state" :class="state.tone" :title="runtimeStatus?.version ?? ''">
          <span class="runtime-dot" aria-hidden="true"></span>
          {{ state.label }}
        </span>
      </div>
      <div class="agent-field agent-model-field">
        <label class="field-label" :for="`agent-${agent}-model`">{{ agentRuntime.AGENT_LABELS[agent] }} 模型</label>
        <AgentModelPicker
          :agent="agent"
          :model-value="config.model"
          :disabled="saving"
          :loading="loading"
          :catalog="catalog"
          :invalid="error?.field === 'model'"
          @update:model-value="emit('model', $event)"
        />
      </div>
      <div class="agent-field agent-thinking-field">
        <label class="field-label" :for="`agent-${agent}-thinking`">{{ agentRuntime.AGENT_LABELS[agent] }} 思考强度</label>
        <div class="agent-select">
          <select
            :id="`agent-${agent}-thinking`"
            :value="config.thinking"
            :disabled="saving"
            :aria-invalid="error?.field === 'thinking'"
            @change="setSelectValue($event, 'thinking')"
          >
            <option v-for="level in capability?.thinking ?? []" :key="level" :value="level">{{ thinkingLabels[level] }}</option>
          </select>
          <AppIcon name="chevron-down" />
        </div>
      </div>
      <button
        class="agent-details-button"
        type="button"
        :aria-label="`${agentRuntime.AGENT_LABELS[agent]} 运行详情`"
        :aria-expanded="expanded"
        :aria-controls="`agent-${agent}-details`"
        @click="emit('toggle')"
      >
        <AppIcon name="chevron-down" />
      </button>
    </div>
    <p v-if="error" :id="`agent-${agent}-error`" class="agent-row-message error" role="alert">
      <AppIcon name="alert" />
      {{ error.message }}
    </p>
    <p v-if="notice" class="agent-row-message warning" role="status">
      <AppIcon name="info" />
      {{ notice }}
    </p>
    <div v-if="expanded" :id="`agent-${agent}-details`" class="agent-details">
      <div class="agent-details-copy">
        <p>{{ description }}。</p>
        <p v-if="capability?.note">{{ capability.note }}</p>
        <p v-if="agent === 'coding-agent'">
          {{
            codingIsolation === 'separate-user'
              ? '所选 CLI 须在 taskpilot-coder 账号内安装并登录；不会使用主账号的编码权限。'
              : '使用你自己账号里装好、登录过的 CLI，运行在 TaskPilot 的沙箱里，见下方「编码隔离」。'
          }}
        </p>
        <p v-if="runtimeStatus?.version" class="runtime-version">{{ runtimeStatus.command }} · {{ runtimeStatus.version }}</p>
        <pre v-if="runtimeStatus?.reason" class="runtime-diagnostic">{{ runtimeStatus.reason }}</pre>
        <p v-if="catalog?.defaultModel">CLI 原生默认模型：{{ catalog.defaultModel }}</p>
        <p v-for="issue in catalog?.issues ?? []" :key="issue" class="model-catalog-issue">{{ issue }}</p>
      </div>
      <button v-if="changed" class="secondary-button small" type="button" :disabled="saving" @click="emit('restore')">
        <AppIcon name="undo" />
        还原此角色
      </button>
    </div>
  </section>
</template>

<style scoped>
.agent-row {
  display: grid;
  grid-template-columns: minmax(175px, 1.2fr) minmax(135px, 0.9fr) minmax(175px, 1.5fr) minmax(104px, 0.65fr) 28px;
  gap: var(--space-3);
  align-items: start;
  min-height: 64px;
  padding: 6px var(--space-4);
}
.agent-settings-card {
  transition: background 0.15s var(--ease);
}
.agent-settings-card + .agent-settings-card {
  border-top: 1px solid var(--line-soft);
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
.model-catalog-issue {
  color: var(--warning);
}
.agent-row-message {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  margin: 0;
  padding: 0 var(--space-4) var(--space-3) 58px;
  font-size: var(--text-xs);
}
.agent-row-message .icon {
  margin-top: 2px;
  width: 14px;
  height: 14px;
}
.agent-row-message.error {
  color: var(--danger);
}
.agent-row-message.warning {
  color: var(--warning);
}
@container agent-settings (max-width: 700px) {
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
