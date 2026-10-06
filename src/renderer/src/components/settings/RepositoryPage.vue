<script setup lang="ts">
import AppIcon from '@/components/AppIcon.vue';
import { useSettingsStore } from '@/stores/settings.ts';
import FieldStatus from './FieldStatus.vue';

const settings = useSettingsStore();

const onPickRoot = () => { settings.pickRoot().catch((error) => console.error(error)); };
</script>

<template>
  <header class="settings-page-header">
    <h2>仓库</h2>
    <span class="scope-badge"><AppIcon name="laptop" />本机配置 · 不写入仓库</span>
  </header>
  <p class="settings-page-intro">TaskPilot 只读观察这个仓库：计算 diff、检查文件范围，不会修改工作树或提交历史。</p>
  <div v-if="settings.workspaceDraft" class="settings-card glass">
    <div class="setting-row stacked">
      <label class="setting-label" for="settingsRoot"><strong>仓库路径</strong><small>选择仓库内的子目录时，会自动改用仓库根目录</small></label>
      <div class="field-row">
        <el-input
          id="settingsRoot" v-model="settings.workspaceDraft.root" class="mono-input" name="root" spellcheck="false" autocomplete="off"
          placeholder="/Users/you/projects/app" aria-describedby="rootStatus" :aria-invalid="String(settings.statuses.root.tone === 'error')"
        />
        <button id="pickRoot" class="secondary-button" type="button" @click="onPickRoot"><AppIcon name="folder" />选择…</button>
      </div>
      <FieldStatus id="rootStatus" :status="settings.statuses.root" />
    </div>
    <div v-if="settings.repoFacts" id="repoFacts" class="repo-facts">
      <dl class="fact-list">
        <template v-for="fact in settings.repoFacts" :key="fact.term"><dt>{{ fact.term }}</dt><dd>{{ fact.value }}</dd></template>
      </dl>
    </div>
  </div>
</template>

<style scoped>
.mono-input :deep(input) { font-family: var(--font-mono); }
</style>
