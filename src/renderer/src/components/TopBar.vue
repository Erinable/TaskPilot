<script setup lang="ts">
import { computed } from 'vue';

import AppIcon from './AppIcon.vue';
import NotificationCenter from './NotificationCenter.vue';
import UserAvatar from './UserAvatar.vue';
import { useAppStore } from '@/stores/app.ts';
import { usePaletteStore } from '@/stores/palette.ts';
import { useRepositoriesStore } from '@/stores/repositories.ts';
import { useSettingsStore } from '@/stores/settings.ts';

const app = useAppStore();
const settings = useSettingsStore();
const palette = usePaletteStore();
const repositories = useRepositoriesStore();

type RepoCommand = { kind: 'switch' | 'relocate'; id: string } | { kind: 'add' | 'settings' };

const onCommand = (command: RepoCommand) => {
  const action =
    command.kind === 'switch'
      ? repositories.switchTo(command.id)
      : command.kind === 'relocate'
        ? repositories.relocate(command.id)
        : command.kind === 'add'
          ? repositories.add()
          : settings.open('repository');
  action.catch((error) => console.error(error));
};
// The list is cheap; reading it on open shows a folder that went missing.
const onVisible = (visible: boolean) => {
  if (visible) repositories.refresh().catch((error) => console.error(error));
};

const workspaceName = computed(() => {
  const info = app.workspaceInfo;
  if (!info?.configured) return '添加仓库';
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
        <div class="brand-caption">AI 团队工作台</div>
      </div>
    </div>
    <el-dropdown trigger="click" placement="bottom-start" popper-class="repo-menu" @command="onCommand" @visible-change="onVisible">
      <button class="workspace-picker" type="button" :aria-label="`当前仓库：${workspaceName}，切换仓库`" :disabled="repositories.switching">
        <AppIcon v-if="repositories.switching" name="spinner" class="spin" />
        <AppIcon v-else name="git-branch" />
        <span id="workspaceName">{{ workspaceName }}</span>
        <span class="repo-dot" :class="{ off: !app.workspaceInfo?.configured }"></span>
        <AppIcon name="chevron-down" class="chevron" />
      </button>
      <template #dropdown>
        <el-dropdown-menu>
          <el-dropdown-item
            v-for="repo in repositories.repositories"
            :key="repo.id"
            :command="repo.missing ? { kind: 'relocate', id: repo.id } : { kind: 'switch', id: repo.id }"
            :class="{ 'is-active': repo.current, missing: repo.missing }"
            :data-repository="repo.id"
          >
            <AppIcon :name="repo.missing ? 'alert' : repo.current ? 'check' : 'folder'" />
            <span class="repo-menu-text">
              <strong>{{ repo.name }}</strong>
              <small>{{ repo.missing ? '找不到这个目录，点击重新指定位置' : repo.root }}</small>
            </span>
          </el-dropdown-item>
          <el-dropdown-item :divided="repositories.repositories.length > 0" :command="{ kind: 'add' }" data-action="add-repository">
            <AppIcon name="plus" />
            添加仓库…
          </el-dropdown-item>
          <el-dropdown-item :command="{ kind: 'settings' }" data-action="repository-settings">
            <AppIcon name="sliders" />
            仓库设置
          </el-dropdown-item>
        </el-dropdown-menu>
      </template>
    </el-dropdown>
    <div class="top-actions">
      <button class="icon-button" type="button" title="搜索（⌘K）" aria-label="搜索" aria-haspopup="dialog" @click="palette.openPalette()">
        <AppIcon name="search" />
      </button>
      <NotificationCenter />
      <UserAvatar
        tag="button"
        class="avatar"
        type="button"
        title="个人资料"
        aria-label="打开个人资料设置"
        :display-name="app.preferences?.profile.displayName ?? ''"
        :avatar-color="app.preferences?.profile.avatarColor ?? 'sunset'"
        @click="settings.open('profile')"
      />
    </div>
  </header>
</template>
