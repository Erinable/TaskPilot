<script setup lang="ts">
import AppIcon from '@/components/AppIcon.vue';
import UserAvatar from '@/components/UserAvatar.vue';
import { NAV_GROUPS, useSettingsStore } from '@/stores/settings.ts';
import ProfilePage from '@/components/settings/ProfilePage.vue';
import PreferencesPage from '@/components/settings/PreferencesPage.vue';
import RepositoryPage from '@/components/settings/RepositoryPage.vue';
import CommandsPage from '@/components/settings/CommandsPage.vue';
import SetupPage from '@/components/settings/SetupPage.vue';
import EnvironmentPage from '@/components/settings/EnvironmentPage.vue';
import DataPage from '@/components/settings/DataPage.vue';

const settings = useSettingsStore();

const run = (promise: Promise<unknown>) => {
  promise.catch((error) => console.error(error));
};
// Enter in a text field saves rather than reloading the page.
const onSubmit = () => run(settings.saveAll());
const onSearch = (event: Event) => settings.search((event.target as HTMLInputElement).value);
</script>

<template>
  <div id="settingsView" class="view settings-view">
    <aside class="settings-nav glass" aria-label="设置分类">
      <h1 class="settings-nav-title">设置</h1>
      <label class="settings-search">
        <AppIcon name="search" />
        <input
          id="settingsSearch"
          :value="settings.searchQuery"
          type="search"
          placeholder="搜索设置"
          autocomplete="off"
          spellcheck="false"
          aria-label="搜索设置"
          @input="onSearch"
        />
      </label>
      <nav id="settingsNav">
        <template v-for="group in NAV_GROUPS" :key="group.id">
          <div v-show="settings.visibleGroups.includes(group.id)" class="settings-group-label" :data-group="group.id">
            <template v-if="group.id === 'personal'">
              <UserAvatar
                id="navAvatar"
                class="group-avatar"
                :display-name="settings.savedPreferences?.profile.displayName ?? ''"
                :avatar-color="settings.savedPreferences?.profile.avatarColor ?? 'sunset'"
              />
              <span>个人</span>
            </template>
            <template v-else-if="group.id === 'workspace'">
              <AppIcon name="git-branch" />
              <span id="navWorkspaceName">{{ settings.navWorkspaceName }}</span>
              <span class="group-tag">工作区</span>
            </template>
            <template v-else>
              <AppIcon name="laptop" />
              <span>本设备</span>
            </template>
          </div>
          <button
            v-for="item in group.items"
            v-show="settings.visiblePages.has(item.page)"
            :key="item.page"
            type="button"
            class="settings-nav-item"
            :class="{ active: settings.activePage === item.page, dirty: settings.dirtyPages[item.page] === true }"
            :data-page="item.page"
            :data-keywords="item.keywords"
            :aria-current="settings.activePage === item.page ? 'page' : undefined"
            @click="settings.openPage(item.page)"
          >
            <AppIcon :name="item.icon" />
            {{ item.label }}
          </button>
        </template>
      </nav>
      <p v-show="settings.visiblePages.size === 0" id="settingsSearchEmpty" class="settings-search-empty">没有匹配的设置</p>
    </aside>

    <div class="settings-content">
      <form v-show="settings.activePage === 'profile'" id="profileForm" class="settings-page" data-page="profile" novalidate @submit.prevent="onSubmit">
        <ProfilePage />
      </form>
      <form
        v-show="settings.activePage === 'preferences'"
        id="appearanceForm"
        class="settings-page"
        data-page="preferences"
        novalidate
        @submit.prevent="onSubmit"
      >
        <PreferencesPage />
      </form>
      <form
        v-show="settings.activePage === 'repository'"
        id="repositoryForm"
        class="settings-page"
        data-page="repository"
        novalidate
        @submit.prevent="onSubmit"
      >
        <RepositoryPage />
      </form>
      <form v-show="settings.activePage === 'commands'" id="commandsForm" class="settings-page" data-page="commands" novalidate @submit.prevent="onSubmit">
        <CommandsPage />
      </form>
      <section v-show="settings.activePage === 'setup'" id="setupPage" class="settings-page" data-page="setup"><SetupPage /></section>
      <form
        v-show="settings.activePage === 'environment'"
        id="environmentForm"
        class="settings-page"
        data-page="environment"
        novalidate
        @submit.prevent="onSubmit"
      >
        <EnvironmentPage />
      </form>
      <section v-show="settings.activePage === 'data'" id="dataPage" class="settings-page" data-page="data"><DataPage /></section>

      <div v-show="settings.anyDirty" id="settingsSavebar" class="settings-savebar glass-strong">
        <span class="savebar-text">
          <AppIcon name="info" />
          <span id="savebarText">{{ settings.savebarText }}</span>
        </span>
        <div class="savebar-actions">
          <button id="discardSettings" class="secondary-button" type="button" :disabled="settings.saving" @click="settings.discardAll()">放弃</button>
          <button
            v-show="settings.dirty.workspace"
            id="checkSettings"
            class="secondary-button"
            type="button"
            :disabled="settings.saving"
            @click="run(settings.checkWorkspace())"
          >
            <AppIcon name="check-circle" />
            检查
          </button>
          <button id="saveSettings" class="primary-button" type="button" :disabled="settings.saving" @click="onSubmit">保存</button>
        </div>
      </div>
    </div>
  </div>
</template>
