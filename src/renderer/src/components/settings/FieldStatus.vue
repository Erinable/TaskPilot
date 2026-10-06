<script setup lang="ts">
import AppIcon from '@/components/AppIcon.vue';
import type { IconName } from '@/lib/icons.ts';
import type { FieldStatus, FieldTone } from '@/stores/settings.ts';

defineProps<{ id: string; status: FieldStatus }>();

const ICONS: Record<FieldTone, IconName> = { ok: 'check-circle', warn: 'alert', error: 'x-circle' };
</script>

<template>
  <p :id="id" class="field-status" :class="status.tone" aria-live="polite">
    <template v-if="status.message">
      <AppIcon v-if="status.tone" :name="ICONS[status.tone]" />
      <span>{{ status.message }}</span>
    </template>
  </p>
</template>
