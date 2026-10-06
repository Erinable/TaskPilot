<script setup lang="ts">
// Renders "foo `bar` baz" as text and <code>; agent text never becomes markup.
import { computed } from 'vue';

import { inlineCodeParts } from '@/lib/inline_code.ts';

const props = defineProps<{ text: string }>();

const parts = computed(() => inlineCodeParts(props.text));
</script>

<template>
  <template v-for="(part, index) in parts" :key="index"><code v-if="part.code">{{ part.text }}</code><template v-else>{{ part.text }}</template></template>
</template>
