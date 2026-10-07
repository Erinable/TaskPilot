<script setup lang="ts">
import AppIcon from '@/components/AppIcon.vue';
import { useRepositoriesStore } from '@/stores/repositories.ts';
import { useSettingsStore } from '@/stores/settings.ts';
import FieldStatus from './FieldStatus.vue';

const settings = useSettingsStore();
const repositories = useRepositoriesStore();

const run = (action: Promise<unknown>) => {
  action.catch((error) => console.error(error));
};
</script>

<template>
  <header class="settings-page-header">
    <h2>仓库</h2>
    <span class="scope-badge">
      <AppIcon name="laptop" />
      本机配置 · 不写入仓库
    </span>
  </header>
  <p class="settings-page-intro">
    TaskPilot 只读观察仓库：计算 diff、检查文件范围，不会修改工作树或提交历史。每个仓库的需求、工作包、验证命令和活动记录分开保存，在顶栏切换。
  </p>
  <div class="settings-card glass">
    <div class="setting-row stacked">
      <div class="setting-label">
        <strong>当前仓库</strong>
        <small>选择仓库内的子目录时，会自动改用仓库根目录</small>
      </div>
      <template v-if="repositories.current">
        <code id="settingsRoot" class="path-chip">{{ repositories.current.root }}</code>
        <p v-if="repositories.current.missing" class="field-status warn" role="status">
          <AppIcon name="alert" />
          找不到这个目录。仓库被移动或改名后，重新指定位置即可保留它的数据。
        </p>
      </template>
      <p v-else class="empty-hint" data-empty="repository">
        <AppIcon name="folder" />
        还没有添加仓库。
      </p>
      <div class="field-row">
        <button id="addRepository" class="secondary-button" type="button" :disabled="repositories.switching" @click="run(repositories.add())">
          <AppIcon name="plus" />
          添加仓库…
        </button>
        <button
          v-if="repositories.current"
          id="relocateRepository"
          class="secondary-button"
          type="button"
          :disabled="repositories.switching"
          @click="run(repositories.relocate(repositories.current.id))"
        >
          <AppIcon name="folder" />
          重新指定位置…
        </button>
      </div>
      <FieldStatus id="rootStatus" :status="settings.statuses.root" />
    </div>
    <div v-if="settings.repoFacts" id="repoFacts" class="repo-facts">
      <dl class="fact-list">
        <template v-for="fact in settings.repoFacts" :key="fact.term">
          <dt>{{ fact.term }}</dt>
          <dd>{{ fact.value }}</dd>
        </template>
      </dl>
    </div>
  </div>
</template>
