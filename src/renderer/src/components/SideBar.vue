<script setup lang="ts">
import { computed } from 'vue';

import AppIcon from './AppIcon.vue';
import ProjectList from './ProjectList.vue';
import { useAppStore } from '@/stores/app.ts';
import type { ViewName } from '@/stores/app.ts';
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

const TEAM_VIEWS: ViewName[] = ['team', 'activity', 'costs'];
const openView = async (view: 'map' | 'release' | 'team' | 'notes') => {
  if (await app.navigate(view)) execution.close();
};

const team = computed(() =>
  activity.TEAM.map(({ agent, actor }) => {
    const presence = activity.presenceOf(app.activity?.team ?? null, agent);
    return { ...actor, agent, presence };
  }),
);
const teamWork = computed(() => activity.teamWorkSummary(app.activity?.team ?? null));
// Collapsed, the status lives in the tooltip and the accessible name.
const teamStatus = computed(() => teamWork.value ?? activity.presenceSummary(app.activity?.team ?? null));
const teamTitle = computed(() => (teamStatus.value ? `AI 团队：${teamStatus.value}` : 'AI 团队'));
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
      <button
        class="nav-item"
        :class="{ active: app.view === 'notes' }"
        :title="app.sidebarCollapsed ? '学习笔记' : undefined"
        data-nav="notes"
        @click="openView('notes')"
      >
        <AppIcon name="list-checks" class="nav-icon" />
        <span class="nav-label">学习笔记</span>
      </button>
    </nav>
    <ProjectList />
    <!-- Members, activity and cost are tabs of one page. -->
    <div class="team-entry-wrap">
      <button
        class="nav-item team-entry"
        :class="{ active: TEAM_VIEWS.includes(app.view), working: teamWork }"
        :title="app.sidebarCollapsed ? teamTitle : undefined"
        :aria-label="teamTitle"
        @click="openView('team')"
      >
        <AppIcon name="bot" class="nav-icon" />
        <span class="nav-label">AI 团队</span>
        <span class="team-stack" aria-hidden="true">
          <span v-for="member in team" :key="member.agent" class="agent-avatar team-stack-avatar" :class="[member.avatar, member.presence]">
            <span v-if="member.presence === 'busy'" class="presence busy"></span>
          </span>
        </span>
      </button>
      <!-- Already part of the entry's accessible name. -->
      <p v-if="teamWork" class="team-entry-work nav-label" aria-hidden="true">{{ teamWork }}</p>
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
.team-entry-wrap {
  margin-top: 28px;
}
.sidebar.collapsed .team-entry-wrap {
  margin-top: var(--space-6);
}
/* One small avatar per member, overlapping; working members stand out, offline ones fade. */
.team-stack {
  display: flex;
  margin-left: auto;
}
.team-stack-avatar {
  position: relative;
  width: 18px;
  height: 18px;
  flex-basis: 18px;
  border-radius: 50%;
  box-shadow: 0 0 0 2px var(--glass-border);
}
.team-stack-avatar + .team-stack-avatar {
  margin-left: -4px;
}
.team-stack-avatar.offline {
  filter: grayscale(1);
  opacity: 0.4;
}
.team-stack-avatar.busy {
  z-index: 1;
  box-shadow: 0 0 0 2px var(--accent);
}
.team-stack .presence.busy {
  position: absolute;
  top: -3px;
  right: -3px;
  width: 7px;
  height: 7px;
  margin: 0;
  background: var(--accent);
  box-shadow: 0 0 0 2px var(--glass-border);
  animation: pulse 1.6s ease-in-out infinite;
}
.sidebar.collapsed .team-stack {
  display: none;
}
.team-entry-work {
  margin: 2px 0 0;
  padding: 0 12px 0 calc(12px + 16px + var(--space-3));
  overflow: hidden;
  color: var(--accent-strong);
  font-size: var(--text-xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* Collapsed, a dot on the icon says someone is working. */
.sidebar.collapsed .team-entry.working::after {
  content: '';
  position: absolute;
  top: 6px;
  right: 10px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 0 2px var(--glass-border);
  animation: pulse 1.6s ease-in-out infinite;
}
</style>
