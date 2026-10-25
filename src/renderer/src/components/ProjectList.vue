<script setup lang="ts">
// The sidebar's projects: every added repository with the work waiting in
// it, one click to switch. The open one counts from the live queue; the
// others from what the main process read from their saved data.
import { computed } from 'vue';

import AppIcon from './AppIcon.vue';
import { countStatuses } from '@shared/repository_counts.ts';
import { useAppStore } from '@/stores/app.ts';
import { useRepositoriesStore } from '@/stores/repositories.ts';
import { useTasksStore } from '@/stores/tasks.ts';
import type * as repositoryTypes from '@shared/ipc/repositories.ts';

const app = useAppStore();
const repositories = useRepositoriesStore();
const tasks = useTasksStore();

// Plain words for a count line, with the parts that are zero left out.
const describe = (counts: repositoryTypes.RepositoryCounts | null): string => {
  if (!counts) return '读不到进度';
  const parts = [
    counts.active ? `${counts.active} 执行中` : null,
    counts.accepting ? `${counts.accepting} 待验收` : null,
    counts.pending ? `${counts.pending} 待执行` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : '没有待办';
};

const projects = computed(() =>
  repositories.repositories.map((repo) => {
    const counts = repo.current ? countStatuses(tasks.tasks.map((task) => task.status)) : repo.counts;
    // Waiting on the developer: claimed work and packages to accept.
    const attention = counts ? counts.active + counts.accepting : 0;
    return { repo, detail: repo.missing ? '找不到这个目录' : describe(counts), attention };
  }),
);

const open = (repo: repositoryTypes.Repository) => {
  if (repo.missing) repositories.relocate(repo.id).catch((error) => console.error(error));
  else if (!repo.current) repositories.switchTo(repo.id).catch((error) => console.error(error));
};
</script>

<template>
  <div class="side-section-label project-label">项目</div>
  <div class="project-list" role="list">
    <button
      v-for="{ repo, detail, attention } in projects"
      :key="repo.id"
      class="nav-item project-item"
      :class="{ active: repo.current, missing: repo.missing }"
      type="button"
      role="listitem"
      :aria-current="repo.current ? 'true' : undefined"
      :disabled="repositories.switching"
      :title="app.sidebarCollapsed ? `${repo.name}：${detail}` : repo.root"
      :data-project="repo.id"
      @click="open(repo)"
    >
      <AppIcon :name="repo.missing ? 'alert' : 'folder'" class="nav-icon" />
      <span class="nav-label project-text">
        <span class="project-name">{{ repo.name }}</span>
        <small class="project-detail">{{ detail }}</small>
      </span>
      <span v-if="attention && !repo.current" class="nav-count">{{ attention }}</span>
    </button>
    <button
      class="nav-item project-add"
      type="button"
      :disabled="repositories.switching"
      :title="app.sidebarCollapsed ? '添加项目' : undefined"
      data-action="add-project"
      @click="repositories.add()"
    >
      <AppIcon name="plus" class="nav-icon" />
      <span class="nav-label">添加项目</span>
    </button>
  </div>
</template>

<style scoped>
.project-label {
  margin-top: 28px;
}
.project-list {
  display: grid;
  gap: 2px;
}
.project-item {
  height: auto;
  min-height: 44px;
  padding-block: 4px;
}
.project-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.project-name,
.project-detail {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.project-detail {
  color: var(--text-tertiary);
  font-size: var(--text-xs);
  font-weight: 400;
}
.project-item.missing .project-detail {
  color: var(--warning);
}
</style>
