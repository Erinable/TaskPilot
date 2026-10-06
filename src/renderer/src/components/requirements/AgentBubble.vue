<script setup lang="ts">
// A message from an agent: avatar, name, optional icon and text.
import AppIcon from '@/components/AppIcon.vue';
import InlineCode from '@/components/InlineCode.vue';
import type { IconName } from '@/lib/icons.ts';

withDefaults(defineProps<{ text?: string | null; tone?: string; iconName?: IconName | null; agent?: 'pm' | 'arch' }>(), {
  text: null,
  tone: '',
  iconName: null,
  agent: 'pm',
});
</script>

<template>
  <div class="agent-message glass" :class="tone">
    <div class="agent-message-head">
      <template v-if="agent === 'arch'">
        <span class="agent-avatar arch">AR</span>
        <strong>Architect</strong>
      </template>
      <template v-else>
        <span class="agent-avatar pm">PM</span>
        <strong>Product Lead</strong>
      </template>
      <AppIcon v-if="iconName" :name="iconName" class="agent-message-icon" />
    </div>
    <p v-if="text"><InlineCode :text="text" /></p>
    <slot />
  </div>
</template>
