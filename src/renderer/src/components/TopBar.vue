<script setup lang="ts">
import { computed } from 'vue';

import AppIcon from './AppIcon.vue';
import UserAvatar from './UserAvatar.vue';
import { useAppStore } from '@/stores/app.ts';
import { useSettingsStore } from '@/stores/settings.ts';

const app = useAppStore();
const settings = useSettingsStore();

const workspaceName = computed(() => {
  const info = app.workspaceInfo;
  if (!info?.configured) return '未配置工作区';
  const name = info.root.split(/[\\/]/).filter(Boolean).pop() ?? info.root;
  return info.branch ? `${name} / ${info.branch}` : name;
});
</script>

<template>
  <header class="topbar glass">
    <div class="brand-area">
      <div class="brand-mark"><AppIcon name="logo" /></div>
      <div>
        <div class="brand-name">TaskPilot</div>
        <div class="brand-caption">AI Team Workspace</div>
      </div>
    </div>
    <div
      class="workspace-picker" role="button" tabindex="0" title="工作区设置"
      @click="settings.open('repository')" @keydown.enter.space.prevent="settings.open('repository')"
    >
      <AppIcon name="git-branch" />
      <span>{{ workspaceName }}</span>
      <span class="repo-dot" :class="{ off: !app.workspaceInfo?.configured }"></span>
      <AppIcon name="chevron-down" class="chevron" />
    </div>
    <div class="top-actions">
      <button class="icon-button" title="搜索" aria-label="搜索"><AppIcon name="search" /></button>
      <button class="icon-button" title="通知" aria-label="通知"><AppIcon name="bell" /><span class="notification-dot"></span></button>
      <UserAvatar
        tag="button" class="avatar" type="button" title="个人资料" aria-label="打开个人资料设置"
        :display-name="app.preferences?.profile.displayName ?? ''" :avatar-color="app.preferences?.profile.avatarColor ?? 'sunset'"
        @click="settings.open('profile')"
      />
    </div>
  </header>
</template>
