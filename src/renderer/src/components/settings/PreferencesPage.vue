<script setup lang="ts">
import AppIcon from '@/components/AppIcon.vue';
import type { IconName } from '@/lib/icons.ts';
import { useSettingsStore } from '@/stores/settings.ts';
import type * as settingsTypes from '@shared/ipc/settings.ts';

const settings = useSettingsStore();

const THEMES: { value: settingsTypes.Theme; label: string; icon: IconName }[] = [
  { value: 'system', label: '跟随系统', icon: 'monitor' },
  { value: 'light', label: '浅色', icon: 'sun' },
  { value: 'dark', label: '深色', icon: 'moon' },
];
// Native vibrancy only exists on macOS.
const isMac = navigator.platform.toLowerCase().includes('mac');
</script>

<template>
  <header class="settings-page-header">
    <h2>偏好设置</h2>
    <span class="scope-badge">
      <AppIcon name="laptop" />
      仅保存在本机
    </span>
  </header>
  <h3 class="settings-section-title">外观</h3>
  <div v-if="settings.preferencesDraft" class="settings-card glass">
    <div class="setting-row stacked">
      <div class="setting-label">
        <strong>主题</strong>
        <small>切换后立即生效</small>
      </div>
      <div class="theme-options" role="radiogroup" aria-label="主题">
        <label v-for="theme in THEMES" :key="theme.value" class="theme-option">
          <input v-model="settings.preferencesDraft.appearance.theme" type="radio" name="theme" :value="theme.value" />
          <span class="theme-preview" :class="theme.value" aria-hidden="true">
            <span></span>
            <span></span>
          </span>
          <span class="theme-name">
            <AppIcon :name="theme.icon" />
            {{ theme.label }}
          </span>
        </label>
      </div>
    </div>
    <div v-if="isMac" id="vibrancyRow" class="setting-row">
      <label class="setting-label" for="prefVibrancy">
        <strong>原生毛玻璃</strong>
        <small>让桌面透过窗口显示。文字对比度会随壁纸变化，仅 macOS 可用。</small>
      </label>
      <div class="setting-control end"><el-switch id="prefVibrancy" v-model="settings.preferencesDraft.appearance.vibrancy" /></div>
    </div>
  </div>
</template>
