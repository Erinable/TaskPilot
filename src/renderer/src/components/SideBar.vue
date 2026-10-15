<script setup lang="ts">
import { computed, nextTick } from 'vue';

import AppIcon from './AppIcon.vue';
import { useAppStore } from '@/stores/app.ts';
import type { ViewName } from '@/stores/app.ts';
import { useTasksStore } from '@/stores/tasks.ts';
import { useRequirementsStore } from '@/stores/requirements.ts';
import { useSettingsStore } from '@/stores/settings.ts';
import { useExecutionStore } from '@/stores/execution.ts';
import * as activity from '@/lib/activity.ts';
import type * as ipc from '@shared/ipc_types.ts';

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

const TEAM_VIEWS: ViewName[] = ['team', 'activity', 'costs'];
const openView = async (view: 'map' | 'release' | 'team') => {
  if (await app.navigate(view)) execution.close();
};

// Opens the team page with that member's card focused.
const openMember = async (agent: ipc.ActivityAgent) => {
  if (!(await app.navigate('team'))) return;
  execution.close();
  await nextTick();
  document.getElementById(`team-${agent}`)?.focus();
};

const team = computed(() =>
  activity.TEAM.map(({ agent, actor }) => {
    const presence = activity.presenceOf(app.activity?.team ?? null, agent);
    return { ...actor, agent, presence, label: activity.PRESENCE_LABELS[presence] };
  }),
);
</script>

<template>
  <aside class="sidebar glass" :class="{ collapsed: app.sidebarCollapsed }">
    <!-- Collapsed, labels stay in the DOM for screen readers and show as native tooltips. -->
    <div class="side-section-label">工作区</div>
    <nav class="main-nav">
      <button
        class="nav-item"
        :class="{ active: app.view === 'queue' || app.view === 'execution' }"
        :title="app.sidebarCollapsed ? `工作队列（${tasks.pendingCount} 个待办）` : undefined"
        @click="showQueue"
      >
        <AppIcon name="queue" class="nav-icon" />
        <span class="nav-label">工作队列</span>
        <span class="nav-count">{{ tasks.pendingCount }}</span>
      </button>
      <button
        class="nav-item"
        :class="{ active: app.view === 'requirements' }"
        :title="app.sidebarCollapsed ? '需求中心' : undefined"
        @click="requirements.open()"
      >
        <AppIcon name="sparkle" class="nav-icon" />
        <span class="nav-label">需求中心</span>
        <span v-if="requirements.attentionCount > 0" class="nav-count attention">{{ requirements.attentionCount }}</span>
      </button>
      <button class="nav-item" :class="{ active: app.view === 'map' }" :title="app.sidebarCollapsed ? '工程地图' : undefined" @click="openView('map')">
        <AppIcon name="map" class="nav-icon" />
        <span class="nav-label">工程地图</span>
      </button>
      <button class="nav-item" :class="{ active: app.view === 'release' }" :title="app.sidebarCollapsed ? '发布' : undefined" @click="openView('release')">
        <AppIcon name="rocket" class="nav-icon" />
        <span class="nav-label">发布</span>
      </button>
    </nav>
    <div class="side-section-label team-label">AI 团队</div>
    <div class="team-list">
      <!-- Members, activity and cost are tabs of one page. -->
      <button
        class="nav-item"
        :class="{ active: TEAM_VIEWS.includes(app.view) }"
        :title="app.sidebarCollapsed ? 'AI 团队' : undefined"
        @click="openView('team')"
      >
        <AppIcon name="bot" class="nav-icon" />
        <span class="nav-label">团队概览</span>
      </button>
      <button
        v-for="member in team"
        :key="member.agent"
        class="team-member"
        type="button"
        :title="`${member.name}：${member.label}`"
        @click="openMember(member.agent)"
      >
        <span class="agent-avatar" :class="member.avatar">{{ member.initials }}</span>
        <span class="nav-label">{{ member.name }}</span>
        <span class="presence" :class="member.presence" role="img" :aria-label="member.label"></span>
      </button>
    </div>
    <div class="sidebar-bottom">
      <div class="sync-card" :title="app.sidebarCollapsed ? `${syncTitle} · ${syncDetail}` : undefined">
        <span class="sync-icon" :class="{ off: !configured }"><AppIcon name="refresh" /></span>
        <div class="nav-label">
          <strong>{{ syncTitle }}</strong>
          <small>{{ syncDetail }}</small>
        </div>
      </div>
      <button
        class="settings-link nav-item"
        :class="{ active: app.view === 'settings' }"
        :title="app.sidebarCollapsed ? '设置' : undefined"
        @click="settings.open()"
      >
        <AppIcon name="settings" class="nav-icon" />
        <span class="nav-label">设置</span>
      </button>
      <button
        class="nav-item sidebar-toggle"
        :aria-expanded="!app.sidebarCollapsed"
        :title="app.sidebarCollapsed ? '展开侧栏' : undefined"
        @click="app.toggleSidebar()"
      >
        <AppIcon name="sidebar" class="nav-icon" />
        <span class="nav-label">{{ app.sidebarCollapsed ? '展开侧栏' : '收起侧栏' }}</span>
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
