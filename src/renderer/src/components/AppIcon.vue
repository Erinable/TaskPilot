<script setup lang="ts">
import { computed } from 'vue';

import { ICONS } from '@/lib/icons.ts';
import type { IconDefinition, IconName } from '@/lib/icons.ts';

const props = defineProps<{ name: IconName }>();

// Typed names are checked by vue-tsc; a task's icon comes from data, so an
// unknown name still renders an empty, sized box.
const definition = computed<IconDefinition | undefined>(() => (ICONS as Record<string, IconDefinition>)[props.name]);
const strokeProps = computed(() => (definition.value?.filled
  ? { fill: 'currentColor', stroke: 'none' }
  : { fill: 'none', stroke: 'currentColor', 'stroke-width': 1.75, 'stroke-linecap': 'round' as const, 'stroke-linejoin': 'round' as const }));
</script>

<template>
  <svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" v-bind="definition ? strokeProps : {}">
    <component :is="tag" v-for="([tag, attributes], index) in definition?.shapes ?? []" :key="index" v-bind="attributes" />
  </svg>
</template>
