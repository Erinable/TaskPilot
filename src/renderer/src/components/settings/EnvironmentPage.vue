<script setup lang="ts">
import { computed } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import { useSettingsStore } from '@/stores/settings.ts';

const settings = useSettingsStore();

const info = computed(() => settings.environment);
const versionFacts = computed(() => (info.value ? [
  { term: 'TaskPilot', value: info.value.versions.app },
  { term: 'Electron', value: info.value.versions.electron },
  { term: 'Node.js', value: info.value.versions.node },
  { term: '平台', value: info.value.platform },
  { term: '登录 shell', value: info.value.shell },
] : []));

// Previewing a source re-reads the PATH before anything is saved.
const onSourceChange = () => { settings.renderEnvironment().catch((error) => console.error(error)); };
const onRefresh = () => { settings.renderEnvironment({ refresh: true }).catch((error) => console.error(error)); };
</script>

<template>
  <header class="settings-page-header">
    <h2>运行环境</h2>
    <span class="scope-badge"><AppIcon name="laptop" />仅本设备</span>
  </header>
  <h3 class="settings-section-title">PATH</h3>
  <div v-if="settings.preferencesDraft" class="settings-card glass">
    <div class="setting-row stacked">
      <div class="setting-label"><strong>验证命令的 PATH 来源</strong><small>从 Finder 或 Dock 启动时，应用拿到的 PATH 通常不包含 nvm、Homebrew 等安装的命令</small></div>
      <div class="choice-list" role="radiogroup" aria-label="PATH 来源">
        <label class="choice">
          <input v-model="settings.preferencesDraft.environment.pathSource" type="radio" name="pathSource" value="inherit" @change="onSourceChange" />
          <span><strong>继承应用启动时的 PATH</strong><small id="inheritSummary">{{ info ? `${info.inheritedCount} 个目录。从终端启动时与终端一致。` : '从终端启动时与终端一致' }}</small></span>
        </label>
        <label class="choice">
          <input v-model="settings.preferencesDraft.environment.pathSource" type="radio" name="pathSource" value="login-shell" @change="onSourceChange" />
          <span><strong>从登录 shell 读取</strong><small id="shellSummary">{{ info ? (info.shell ? `运行 ${info.shell} 一次，读取它的 PATH 并在本次会话中缓存` : '未检测到登录 shell') : '启动一次你的 shell 并读取它的 PATH' }}</small></span>
        </label>
      </div>
    </div>
    <div class="setting-row stacked">
      <div class="path-header">
        <div class="setting-label"><strong>当前生效的 PATH</strong><small id="pathSourceNote" :class="{ 'warn-text': settings.pathNote.warn }">{{ settings.pathNote.text }}</small></div>
        <button id="refreshPath" class="secondary-button small" type="button" @click="onRefresh"><AppIcon name="refresh" />重新读取</button>
      </div>
      <ol id="pathList" class="path-list">
        <li v-if="settings.environmentLoading">读取中…</li>
        <li v-else-if="settings.environmentError">{{ settings.environmentError }}</li>
        <template v-else-if="info">
          <li v-for="(entry, index) in info.entries" :key="index" :class="{ added: !settings.inheritedEntries.has(entry) }">{{ entry }}</li>
        </template>
      </ol>
    </div>
  </div>
  <h3 class="settings-section-title">版本</h3>
  <div class="settings-card glass">
    <dl id="versionFacts" class="fact-list">
      <template v-for="fact in versionFacts" :key="fact.term"><dt>{{ fact.term }}</dt><dd>{{ fact.value ?? '—' }}</dd></template>
    </dl>
  </div>
</template>
