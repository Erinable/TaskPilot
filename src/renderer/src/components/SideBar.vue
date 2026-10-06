<script setup lang="ts">
import { computed } from 'vue';

import AppIcon from './AppIcon.vue';
import { useAppStore } from '@/stores/app.ts';
import { useTasksStore } from '@/stores/tasks.ts';
import { useRequirementsStore } from '@/stores/requirements.ts';
import { useSettingsStore } from '@/stores/settings.ts';
import { useExecutionStore } from '@/stores/execution.ts';

const app = useAppStore();
const tasks = useTasksStore();
const requirements = useRequirementsStore();
const settings = useSettingsStore();
const execution = useExecutionStore();

const configured = computed(() => app.workspaceInfo?.configured === true);
const syncTitle = computed(() => {
  const info = app.workspaceInfo;
  if (!info?.configured) return '未配置工作区';
  return info.dirty ? `${info.changedFiles} 个文件有改动` : '工作区干净';
});
const syncDetail = computed(() => {
  const info = app.workspaceInfo;
  if (app.workspaceError) return app.workspaceError;
  if (!info?.configured) return '前往设置指定仓库';
  return `${info.commit.slice(0, 8)} · ${info.branch ?? 'detached'}`;
});

const showQueue = async () => {
  if (await app.navigate('queue')) execution.close();
};

const TEAM = [
  { avatar: 'pm', initials: 'PM', name: 'Product Lead', presence: 'online' },
  { avatar: 'arch', initials: 'AR', name: 'Architect', presence: 'online' },
  { avatar: 'qa', initials: 'QA', name: 'QA Partner', presence: 'idle' },
  { avatar: 'rel', initials: 'RM', name: 'Release Manager', presence: 'online' },
];
</script>

<template>
  <aside class="sidebar glass">
    <div class="side-section-label">WORKSPACE</div>
    <nav class="main-nav">
      <button class="nav-item" :class="{ active: app.view === 'queue' || app.view === 'execution' }" @click="showQueue">
        <AppIcon name="queue" class="nav-icon" /><span>工作队列</span><span class="nav-count">{{ tasks.pendingCount }}</span>
      </button>
      <button class="nav-item" :class="{ active: app.view === 'requirements' }" @click="requirements.open()">
        <AppIcon name="sparkle" class="nav-icon" /><span>需求中心</span>
        <span v-if="requirements.attentionCount > 0" class="nav-count attention">{{ requirements.attentionCount }}</span>
      </button>
      <button class="nav-item"><AppIcon name="map" class="nav-icon" /><span>工程地图</span></button>
      <button class="nav-item"><AppIcon name="activity" class="nav-icon" /><span>活动记录</span></button>
    </nav>
    <div class="side-section-label team-label">AI TEAM</div>
    <div class="team-list">
      <div v-for="member in TEAM" :key="member.initials" class="team-member">
        <span class="agent-avatar" :class="member.avatar">{{ member.initials }}</span><span>{{ member.name }}</span><span class="presence" :class="member.presence"></span>
      </div>
    </div>
    <div class="sidebar-bottom">
      <div class="sync-card">
        <span class="sync-icon" :class="{ off: !configured }"><AppIcon name="refresh" /></span>
        <div><strong>{{ syncTitle }}</strong><small>{{ syncDetail }}</small></div>
      </div>
      <button class="settings-link nav-item" :class="{ active: app.view === 'settings' }" @click="settings.open()">
        <AppIcon name="settings" class="nav-icon" /><span>设置</span>
      </button>
    </div>
  </aside>
</template>
