<script setup lang="ts">
// The AI team's three pages, reached from one sidebar entry: who is on it,
// what it did, and what it cost.
import AppIcon from './AppIcon.vue';
import type { IconName } from '@/lib/icons.ts';
import { useAppStore } from '@/stores/app.ts';

const app = useAppStore();

const TABS: { view: 'team' | 'activity' | 'costs'; label: string; icon: IconName }[] = [
  { view: 'team', label: '成员', icon: 'bot' },
  { view: 'activity', label: '活动记录', icon: 'activity' },
  { view: 'costs', label: '成本', icon: 'coins' },
];

const go = (view: (typeof TABS)[number]['view']) => {
  if (app.view !== view) app.navigate(view).catch((error) => console.error(error));
};
</script>

<template>
  <nav class="team-tabs" aria-label="AI 团队">
    <button
      v-for="tab in TABS"
      :key="tab.view"
      class="team-tab"
      :class="{ active: app.view === tab.view }"
      type="button"
      :aria-current="app.view === tab.view ? 'page' : undefined"
      :data-team-tab="tab.view"
      @click="go(tab.view)"
    >
      <AppIcon :name="tab.icon" />
      {{ tab.label }}
    </button>
  </nav>
</template>

<style scoped>
.team-tabs {
  display: flex;
  gap: var(--space-1);
  margin-bottom: var(--space-4);
  border-bottom: 1px solid var(--line-soft);
}
.team-tab {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  padding: 8px 14px;
  color: var(--text-secondary);
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  font-size: var(--text-md);
}
.team-tab .icon {
  width: 16px;
  height: 16px;
}
.team-tab:hover {
  color: var(--text);
}
.team-tab.active {
  color: var(--accent-strong);
  border-bottom-color: var(--accent);
  font-weight: 600;
}
.team-tab:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
</style>
