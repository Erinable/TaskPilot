<script setup lang="ts">
import { computed, onMounted } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import { useAppStore } from '@/stores/app.ts';
import { useReleaseStore } from '@/stores/release.ts';

// "Planned for 0.3.0" on a published requirement: pick an open version
// plan, or none. Plans are created on the release page.
const props = defineProps<{ requirementId: string }>();
const release = useReleaseStore();
const app = useAppStore();

const open = computed(() => (release.state?.milestones ?? []).filter((milestone) => !milestone.releasedAt));
const current = computed(() => open.value.find((milestone) => milestone.requirementIds.includes(props.requirementId))?.id ?? null);
const NONE = '';
const choose = (value: string) => {
  release.assignMilestone(props.requirementId, value === NONE ? null : value).catch((error) => console.error(error));
};

onMounted(() => {
  if (!release.state) release.load().catch((error) => console.error(error));
});
</script>

<template>
  <div class="milestone-picker">
    <AppIcon name="flag" />
    <label :for="`milestone-${requirementId}`">计划放进</label>
    <el-select
      v-if="open.length"
      :id="`milestone-${requirementId}`"
      :model-value="current ?? NONE"
      class="milestone-select"
      size="small"
      :disabled="release.milestoneBusy"
      aria-label="计划放进哪个版本"
      @update:model-value="choose"
    >
      <el-option :value="NONE" label="不放进版本计划" />
      <el-option v-for="milestone in open" :key="milestone.id" :value="milestone.id" :label="milestone.version" />
    </el-select>
    <button v-else class="link-button" type="button" @click="app.navigate('release')">还没有版本计划，去发布页新建</button>
  </div>
</template>

<style scoped>
.milestone-picker {
  display: flex;
  gap: var(--space-2);
  align-items: center;
  color: var(--text-secondary);
  font-size: var(--text-sm);
}
.milestone-picker .icon {
  width: 14px;
  height: 14px;
}
.milestone-select {
  width: 180px;
}
</style>
