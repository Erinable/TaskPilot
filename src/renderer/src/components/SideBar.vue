<script setup lang="ts">
import { computed } from 'vue';

import AppIcon from './AppIcon.vue';
import { useAppStore } from '@/stores/app.ts';
import { useTasksStore } from '@/stores/tasks.ts';
import { useRequirementsStore } from '@/stores/requirements.ts';
import { useSettingsStore } from '@/stores/settings.ts';
import { useExecutionStore } from '@/stores/execution.ts';
import * as activity from '@/lib/activity.ts';

const app = useAppStore();
const tasks = useTasksStore();
const requirements = useRequirementsStore();
const settings = useSettingsStore();
const execution = useExecutionStore();

const configured = computed(() => app.workspaceInfo?.configured === true);
const syncTitle = computed(() => {
  const info = app.workspaceInfo;
  if (!info?.configured) return '还没有仓库';
  return info.dirty ? `${info.changedFiles} 个文件有改动` : '工作区干净';
});
const syncDetail = computed(() => {
  const info = app.workspaceInfo;
  if (app.workspaceError) return app.workspaceError;
  if (!info?.configured) return '点顶栏的仓库菜单添加';
  return `${info.commit.slice(0, 8)} · ${info.branch ?? 'detached'}`;
});

const showQueue = async () => {
  if (await app.navigate('queue')) execution.close();
};

const openView = async (view: 'map' | 'activity' | 'release') => {
  if (await app.navigate(view)) execution.close();
};

const team = computed(() =>
  activity.TEAM.map(({ agent, actor }) => {
    const presence = activity.presenceOf(app.activity?.team ?? null, agent);
    return { ...actor, presence, label: activity.PRESENCE_LABELS[presence] };
  }),
);
</script>

<template>
  <aside class="sidebar glass">
    <div class="side-section-label">工作区</div>
    <nav class="main-nav">
      <button class="nav-item" :class="{ active: app.view === 'queue' || app.view === 'execution' }" @click="showQueue">
        <AppIcon name="queue" class="nav-icon" />
        <span>工作队列</span>
        <span class="nav-count">{{ tasks.pendingCount }}</span>
      </button>
      <button class="nav-item" :class="{ active: app.view === 'requirements' }" @click="requirements.open()">
        <AppIcon name="sparkle" class="nav-icon" />
        <span>需求中心</span>
        <span v-if="requirements.attentionCount > 0" class="nav-count attention">{{ requirements.attentionCount }}</span>
      </button>
      <button class="nav-item" :class="{ active: app.view === 'map' }" @click="openView('map')">
        <AppIcon name="map" class="nav-icon" />
        <span>工程地图</span>
      </button>
      <button class="nav-item" :class="{ active: app.view === 'activity' }" @click="openView('activity')">
        <AppIcon name="activity" class="nav-icon" />
        <span>活动记录</span>
      </button>
      <button class="nav-item" :class="{ active: app.view === 'release' }" @click="openView('release')">
        <AppIcon name="rocket" class="nav-icon" />
        <span>发布</span>
      </button>
    </nav>
    <div class="side-section-label team-label">AI 团队</div>
    <div class="team-list">
      <div v-for="member in team" :key="member.initials" class="team-member" :title="member.label">
        <span class="agent-avatar" :class="member.avatar">{{ member.initials }}</span>
        <span>{{ member.name }}</span>
        <span class="presence" :class="member.presence" role="img" :aria-label="member.label"></span>
      </div>
    </div>
    <div class="sidebar-bottom">
      <div class="sync-card">
        <span class="sync-icon" :class="{ off: !configured }"><AppIcon name="refresh" /></span>
        <div>
          <strong>{{ syncTitle }}</strong>
          <small>{{ syncDetail }}</small>
        </div>
      </div>
      <button class="settings-link nav-item" :class="{ active: app.view === 'settings' }" @click="settings.open()">
        <AppIcon name="settings" class="nav-icon" />
        <span>设置</span>
      </button>
    </div>
  </aside>
</template>

<style scoped>
/* Busy reads as working, offline as unreachable; online keeps the theme's dot. */
.presence.busy {
  background: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
  animation: pulse 1.6s ease-in-out infinite;
}
.presence.offline {
  background: var(--text-tertiary);
  opacity: 0.6;
}
</style>
