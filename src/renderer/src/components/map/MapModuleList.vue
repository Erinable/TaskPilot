<script setup lang="ts">
// Every summarized module, capped with "显示更多" so long lists stay light.
import { computed, ref } from 'vue';

import InlineCode from '@/components/InlineCode.vue';
import type * as ipc from '@shared/ipc_types.ts';
import { FRESHNESS } from './map_wording.ts';

const PAGE_SIZE = 50;

const props = defineProps<{ modules: ipc.MapModule[] }>();
const emit = defineEmits<{ select: [path: string] }>();

const limit = ref(PAGE_SIZE);
const shown = computed(() => props.modules.slice(0, limit.value));
</script>

<template>
  <div class="map-module-list">
    <button v-for="module in shown" :key="module.path" type="button" class="map-module-item" :data-module="module.path" @click="emit('select', module.path)">
      <span class="map-module-top">
        <code class="map-module-path">{{ module.path }}</code>
        <span class="status-pill" :class="FRESHNESS[module.freshness].tone">{{ FRESHNESS[module.freshness].label }}</span>
      </span>
      <span class="map-module-purpose"><InlineCode :text="module.purpose" /></span>
    </button>
    <button v-if="props.modules.length > limit" type="button" class="view-all-button" data-more @click="limit += PAGE_SIZE">
      显示更多（还有 {{ props.modules.length - limit }} 个）
    </button>
  </div>
</template>

<style scoped>
.map-module-list {
  display: flex;
  flex-direction: column;
}
.map-module-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 20px;
  text-align: left;
  border-top: 1px solid var(--line-soft);
  transition: background 0.15s var(--ease);
}
.map-module-item:hover {
  background: var(--fill);
}
.map-module-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.map-module-path {
  color: var(--text);
  font-size: var(--text-sm);
  font-weight: 600;
  word-break: break-all;
}
.map-module-top .status-pill {
  font-size: var(--text-sm);
}
.map-module-purpose {
  color: var(--text-muted);
  font-size: var(--text-sm);
  line-height: 1.5;
}
.view-all-button {
  font-size: var(--text-sm);
}
</style>
