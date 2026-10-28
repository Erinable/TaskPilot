<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue';

import type * as agentRuntime from '@shared/agent_runtime.ts';

const props = defineProps<{
  agent: agentRuntime.AgentId;
  modelValue: string;
  disabled: boolean;
  loading: boolean;
  catalog: agentRuntime.CliModelCatalog | undefined;
  invalid: boolean;
}>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
const modelQuery = ref('');

const options = () => {
  const native = props.catalog?.models ?? [];
  return props.modelValue && !native.some((option) => option.id === props.modelValue)
    ? [{ id: props.modelValue, label: props.modelValue, provider: null, variants: [], source: 'config' as const }, ...native]
    : native;
};
const defaultModelLabel = () => (props.catalog?.defaultModel ? `CLI 默认 · ${props.catalog.defaultModel}` : '使用 CLI 默认模型');
const matchesQuery = (option: agentRuntime.CliModelOption) => {
  const term = modelQuery.value.trim().toLowerCase();
  return !term || `${option.id} ${option.label} ${option.provider ?? ''}`.toLowerCase().includes(term);
};
const modelGroups = () => {
  const groups = new Map<string, agentRuntime.CliModelOption[]>();
  for (const option of options()) {
    if (!matchesQuery(option)) continue;
    const label = option.provider ?? 'CLI 模型';
    const group = groups.get(label);
    if (group) group.push(option);
    else groups.set(label, [option]);
  }
  return [...groups].map(([label, groupedOptions]) => ({ label, options: groupedOptions }));
};
const syncAccessibility = async () => {
  await nextTick();
  const input = document.getElementById(`agent-${props.agent}-model`);
  if (!input) return;
  input.setAttribute('aria-invalid', String(props.invalid));
  input.setAttribute(
    'aria-describedby',
    ['agentModelHelp', props.invalid ? `agent-${props.agent}-error` : null].filter((id): id is string => id !== null).join(' '),
  );
};
onMounted(() => syncAccessibility().catch((error) => console.error(error)));
watch(
  () => props.invalid,
  () => syncAccessibility().catch((error) => console.error(error)),
  { flush: 'post' },
);
</script>

<template>
  <el-select
    :id="`agent-${agent}-model`"
    :model-value="modelValue"
    :disabled="disabled"
    :loading="loading"
    :aria-invalid="invalid"
    aria-describedby="agentModelHelp"
    class="agent-model-input"
    :popper-class="`agent-model-options agent-model-options-${agent}`"
    :placeholder="defaultModelLabel()"
    filterable
    :allow-create="!options().some((option) => matchesQuery(option))"
    :filter-method="(value: string) => (modelQuery = value)"
    default-first-option
    clearable
    :fit-input-width="true"
    :reserve-keyword="false"
    @update:model-value="(value: string) => emit('update:modelValue', value ?? '')"
    @visible-change="
      (visible: boolean) => {
        if (!visible) modelQuery = '';
      }
    "
  >
    <el-option v-if="!modelQuery" value="" :label="defaultModelLabel()" />
    <el-option-group v-for="group in modelGroups()" :key="group.label" :label="group.label">
      <el-option v-for="option in group.options" :key="option.id" :value="option.id" :label="option.id">
        <span class="model-option-name">{{ option.label }}</span>
        <small v-if="option.label !== option.id" class="model-option-id">{{ option.id }}</small>
      </el-option>
    </el-option-group>
  </el-select>
  <span v-if="catalog?.issues.length" class="model-catalog-note" :title="catalog.issues.join('\n')">目录不可用 · 可填写模型 ID</span>
</template>

<style scoped>
.agent-model-input {
  width: 100%;
}
:deep(.el-select__wrapper) {
  min-height: 36px;
  padding: 0 10px;
  background: var(--glass-bg-strong);
  border-radius: var(--radius-md);
  box-shadow: 0 0 0 1px var(--line-soft) inset;
}
:deep(.el-select__wrapper.is-focused) {
  box-shadow:
    0 0 0 1px var(--accent) inset,
    0 0 0 3px var(--accent-soft);
}
:deep(.el-select__input),
:deep(.el-select__selected-item) {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}
:deep(.el-select__wrapper:has([aria-invalid='true'])) {
  box-shadow: 0 0 0 1px var(--danger) inset;
}
.model-catalog-note {
  display: block;
  margin-top: 3px;
  color: var(--warning);
  font-size: 11px;
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
</style>
