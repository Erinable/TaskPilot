<script setup lang="ts">
import AppIcon from '@/components/AppIcon.vue';
import { useExecutionStore } from '@/stores/execution.ts';
import type * as packageTypes from '@shared/ipc/packages.ts';

// A package's dependencies: done ones ticked, open ones linked, and, while
// the package has not started, a way to stop waiting for one.
const props = defineProps<{ task: packageTypes.TaskView; compact?: boolean }>();
const execution = useExecutionStore();

const STATE_TEXT = (dependency: packageTypes.PackageDependency) =>
  dependency.status === null ? '已不存在' : dependency.status === 'done' ? '已完成' : dependency.waived ? '已解除，不再等待' : '未完成';

const open = (dependency: packageTypes.PackageDependency) => {
  if (dependency.status !== null) execution.open(dependency.id).catch((error) => console.error(error));
};
const waive = (dependency: packageTypes.PackageDependency) => {
  execution.waiveDependency(props.task, dependency).catch((error) => console.error(error));
};
</script>

<template>
  <section class="dependency-list" :class="{ compact }" :aria-label="`${task.title} 的前置工作包`">
    <strong v-if="!compact">前置工作包</strong>
    <ul>
      <li v-for="dependency in task.dependencies" :key="dependency.id" :class="{ blocking: dependency.blocking }">
        <AppIcon :name="dependency.blocking ? 'clock' : 'check'" />
        <button class="link-button" type="button" :disabled="dependency.status === null" @click.stop="open(dependency)">
          {{ dependency.title ?? dependency.id }}
        </button>
        <span class="dependency-state">{{ STATE_TEXT(dependency) }}</span>
        <button v-if="dependency.blocking && task.status === 'pending'" class="link-button subtle" type="button" @click.stop="waive(dependency)">
          不等了，解除依赖
        </button>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.dependency-list {
  display: grid;
  gap: var(--space-2);
  margin-bottom: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-md);
  background: var(--fill);
  font-size: var(--text-sm);
}
.dependency-list.compact {
  margin: 0;
  padding: 0;
  border: 0;
  background: none;
}
ul {
  display: grid;
  gap: var(--space-1);
  margin: 0;
  padding: 0;
  list-style: none;
}
li {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  align-items: center;
  color: var(--success);
}
li.blocking {
  color: var(--text-secondary);
}
li .icon {
  width: 14px;
  height: 14px;
  flex: none;
}
.dependency-state {
  color: var(--text-tertiary);
}
.link-button.subtle {
  color: var(--text-secondary);
}
</style>
