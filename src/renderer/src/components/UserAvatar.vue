<script setup lang="ts">
import { computed } from 'vue';

import AppIcon from './AppIcon.vue';
import { avatarColorOf, initialsOf } from '@/lib/avatar.ts';

const props = defineProps<{ displayName: string; avatarColor: string; tag?: string }>();

const initials = computed(() => initialsOf(props.displayName));
</script>

<template>
  <component :is="tag ?? 'span'" :class="[avatarColorOf(avatarColor), { empty: !initials }]">
    <template v-if="initials">{{ initials }}</template>
    <AppIcon v-else name="user" />
  </component>
</template>
