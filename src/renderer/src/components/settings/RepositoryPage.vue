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
    TaskPilot 观察仓库来计算 diff、检查文件范围。它只在你点「提交」时把完成的工作包写进 git
    历史，从不推送、不切换分支。每个仓库的需求、工作包、验证命令和活动记录分开保存，在顶栏切换。
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
        <button id="createRepository" class="secondary-button" type="button" :disabled="repositories.switching" @click="run(repositories.create())">
          <AppIcon name="folder" />
          新建项目…
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
  <div v-if="repositories.repositories.length" class="settings-card glass">
    <div class="setting-row stacked">
      <div class="setting-label">
        <strong>所有仓库</strong>
        <small>移除只是从列表里拿掉，不删除文件夹，也不删除它的需求和进度；再次添加同一个文件夹即可找回</small>
      </div>
      <ul class="repository-list">
        <li v-for="repo in repositories.repositories" :key="repo.id" :data-repository="repo.id">
          <span class="repository-text">
            <strong>
              {{ repo.name }}
              <template v-if="repo.current">（当前）</template>
            </strong>
            <code class="path-chip">{{ repo.root }}</code>
          </span>
          <button
            class="secondary-button small"
            type="button"
            data-action="remove-repository"
            :disabled="repositories.switching"
            :aria-label="`移除 ${repo.name}`"
            @click="run(repositories.remove(repo.id))"
          >
            <AppIcon name="trash" />
            移除
          </button>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.repository-list {
  display: grid;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}
.repository-list li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}
.repository-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.repository-text .path-chip {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
