<script setup lang="ts">
import { computed } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import { useSettingsStore } from '@/stores/settings.ts';

const settings = useSettingsStore();

const resetSummary = computed(() => {
  const packages = settings.dataInfo?.packages;
  if (!packages) return '清除领取状态、基线、步骤进度和偏差记录。工作区配置和偏好设置保留。';
  return `清除领取状态、基线、步骤进度和偏差记录（当前 ${packages.total} 个工作包，${packages.claimed} 个已领取，${packages.deviations} 条偏差）。工作区配置和偏好设置保留。`;
});
const resetDisabled = computed(() => Boolean(settings.dataInfo && settings.dataInfo.packages.claimed === 0 && settings.dataInfo.packages.deviations === 0));

const onReveal = () => { settings.revealData().catch((error) => console.error(error)); };
const onReset = () => { settings.resetProgress().catch((error) => console.error(error)); };
</script>

<template>
  <header class="settings-page-header">
    <h2>数据</h2>
    <span class="scope-badge"><AppIcon name="laptop" />仅本设备</span>
  </header>
  <h3 class="settings-section-title">存储位置</h3>
  <div class="settings-card glass">
    <div class="setting-row stacked">
      <div class="path-header">
        <div class="setting-label"><strong>数据目录</strong><small>工作区配置、偏好设置和工作包进度都保存在这里</small></div>
        <button id="revealData" class="secondary-button small" type="button" @click="onReveal"><AppIcon name="folder" />在访达中显示</button>
      </div>
      <code id="dataDir" class="path-chip">{{ settings.dataInfo?.configDir }}</code>
      <ul id="dataFiles" class="file-list">
        <li v-for="file in settings.dataInfo?.files ?? []" :key="file"><AppIcon name="file" /><code>{{ file }}</code></li>
      </ul>
    </div>
  </div>
  <h3 class="settings-section-title danger">危险操作</h3>
  <div class="settings-card glass danger-zone">
    <div class="setting-row">
      <div class="setting-label"><strong>重置工作包进度</strong><small id="resetSummary">{{ resetSummary }}</small></div>
      <div class="setting-control end">
        <button id="resetProgress" class="secondary-button danger" type="button" :disabled="resetDisabled" @click="onReset"><AppIcon name="trash" />重置…</button>
      </div>
    </div>
  </div>
</template>
