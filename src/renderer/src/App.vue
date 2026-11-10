<script setup lang="ts">
import { defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import TopBar from './components/TopBar.vue';
import SideBar from './components/SideBar.vue';
import SidebarResizer from './components/SidebarResizer.vue';
import QueueView from './views/QueueView.vue';
import ExecutionView from './views/ExecutionView.vue';
import RequirementsView from './views/RequirementsView.vue';
import CommandPalette from './components/CommandPalette.vue';
import { useAppStore } from './stores/app.ts';
import { useTasksStore } from './stores/tasks.ts';
import { useRequirementsStore } from './stores/requirements.ts';
import { useSettingsStore } from './stores/settings.ts';
import { useExecutionStore } from './stores/execution.ts';
import { useNotificationsStore } from './stores/notifications.ts';
import { useRepositoriesStore } from './stores/repositories.ts';
import { useCodingActivityStore } from './stores/coding_activity.ts';
import { useCoursesStore } from './stores/courses.ts';
import { useDataManagementStore } from './stores/data_management.ts';
import { describeError } from './lib/errors.ts';
import { openDialogs, showToast } from './lib/feedback.ts';
import { hideSplash } from './lib/splash.ts';
import { recoverBackupDrafts } from './lib/local_draft.ts';

// Views most sessions never open load when first shown, keeping them out of
// the startup bundle.
const MapView = defineAsyncComponent(() => import('./views/MapView.vue'));
const ActivityView = defineAsyncComponent(() => import('./views/ActivityView.vue'));
const ReleaseView = defineAsyncComponent(() => import('./views/ReleaseView.vue'));
const TeamView = defineAsyncComponent(() => import('./views/TeamView.vue'));
const CostView = defineAsyncComponent(() => import('./views/CostView.vue'));
const CourseView = defineAsyncComponent(() => import('./views/CourseView.vue'));
// Notes bring KaTeX and syntax highlighting; they load when first opened.
const NotesView = defineAsyncComponent(() => import('./views/NotesView.vue'));
// Draws a mermaid graph, so it loads like the notes page.
const MasteryView = defineAsyncComponent(() => import('./views/MasteryView.vue'));
// Settings is opened often but rarely first: it loads in its own chunk and is
// fetched once the app is idle after startup (see onMounted), so the first
// open finds it ready.
const loadSettingsView = () => import('./views/SettingsView.vue');
const SettingsView = defineAsyncComponent(loadSettingsView);

const app = useAppStore();
const tasks = useTasksStore();
const requirements = useRequirementsStore();
const settings = useSettingsStore();
const execution = useExecutionStore();
const repositories = useRepositoriesStore();
const codingActivity = useCodingActivityStore();
const dataManagement = useDataManagementStore();
const restoreButton = ref<HTMLButtonElement | null>(null);
watch(
  () => dataManagement.rollbackPath,
  async (pending) => {
    if (pending) {
      await nextTick();
      restoreButton.value?.focus();
    }
  },
);

// Settings mounts the first time it is shown and then stays mounted (v-show),
// so unsaved drafts survive leaving it without every page mounting at startup.
const settingsMounted = ref(app.view === 'settings');
watch(
  () => app.view,
  (view) => {
    if (view === 'settings') settingsMounted.value = true;
  },
  { flush: 'sync' },
);

// Dialogs (Element Plus) handle their own Escape; these are the page shortcuts.
const onKeydown = (event: KeyboardEvent) => {
  if (openDialogs.value > 0 || repositories.switching || dataManagement.rollbackPath) return;
  if (event.key === 'Escape' && app.view === 'execution' && !execution.deviationOpen) {
    app
      .navigate('queue')
      .then((left) => left && execution.close())
      .catch((error) => console.error(error));
  } else if ((event.metaKey || event.ctrlKey) && event.key === 's' && app.view === 'settings') {
    event.preventDefault();
    settings.saveAll().catch((error) => console.error(error));
  } else if ((event.metaKey || event.ctrlKey) && event.key === ',') {
    event.preventDefault();
    settings.open().catch((error) => console.error(error));
  }
};

onMounted(async () => {
  try {
    if (await recoverBackupDrafts()) {
      showToast('备份中的未提交草稿已恢复到本机。打开对应表单后可选择恢复或丢弃。', 'info');
    }
  } catch (error) {
    showToast(`备份草稿尚未恢复：${describeError(error)}。恢复文件仍保留，重新打开应用会再次尝试。`, 'error');
  }
  document.addEventListener('keydown', onKeydown);
  app.startActivity();
  codingActivity.start();
  // Notification read state is per repository, so the list comes first.
  await repositories.refresh();
  useNotificationsStore().useRepository(repositories.currentId);
  requirements.init().catch((error) => console.error(error));
  // The rest is independent; the splash stays until all of it is in.
  const [, , info] = await Promise.all([
    app.loadPreferences().catch((error) => console.error('Failed to load preferences', error)),
    tasks.reloadQueue().catch((error) => {
      console.error('Failed to load tasks', error);
      showToast(`工作包加载失败：${describeError(error)}`);
    }),
    app.refreshWorkspaceStatus(),
    useCoursesStore()
      .loadDefault()
      .catch((error) => console.error('Failed to load the default course pack', error)),
  ]);
  hideSplash();
  requestIdleCallback(() => loadSettingsView().catch((error) => console.error('Failed to load settings', error)));
  if (info && !info.configured) showToast('还没有添加仓库，点顶栏的仓库菜单添加一个。', 'info');
});

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown);
  app.stopActivity();
  codingActivity.stop();
});
</script>

<template>
  <!-- Soft colour fields behind every frosted surface; the glass blurs these. -->
  <div class="backdrop" aria-hidden="true">
    <span class="orb orb-a"></span>
    <span class="orb orb-b"></span>
    <span class="orb orb-c"></span>
  </div>

  <div
    class="window-shell"
    :inert="repositories.switching || Boolean(dataManagement.rollbackPath)"
    :aria-busy="repositories.switching || Boolean(dataManagement.rollbackPath)"
  >
    <TopBar />
    <!-- :style goes through the CSSOM, which the page CSP allows (unlike style attributes). -->
    <div class="app-grid" :class="{ 'sidebar-collapsed': app.sidebarCollapsed }" :style="{ '--sidebar-width': `${app.sidebarWidth}px` }">
      <div class="sidebar-slot">
        <SideBar />
        <SidebarResizer />
      </div>
      <!-- Settings and the requirement center lay out their own columns edge to edge. -->
      <main class="main-content" :class="{ 'full-bleed': app.view === 'settings' || app.view === 'requirements' }">
        <!-- Keyed on the repository switch, so each view remounts and reloads its own state. -->
        <div v-if="app.view !== 'settings'" :key="repositories.generation" class="view-host">
          <QueueView v-if="app.view === 'queue'" />
          <ExecutionView v-else-if="app.view === 'execution'" />
          <RequirementsView v-else-if="app.view === 'requirements'" />
          <MapView v-else-if="app.view === 'map'" />
          <ActivityView v-else-if="app.view === 'activity'" />
          <ReleaseView v-else-if="app.view === 'release'" />
          <TeamView v-else-if="app.view === 'team'" />
          <CostView v-else-if="app.view === 'costs'" />
          <NotesView v-else-if="app.view === 'notes'" />
          <MasteryView v-else-if="app.view === 'mastery'" />
          <CourseView v-else-if="app.view === 'courses'" />
        </div>
        <!-- Once shown, settings stays mounted so unsaved drafts survive leaving and coming back. -->
        <SettingsView v-if="settingsMounted" v-show="app.view === 'settings'" />
      </main>
    </div>
  </div>
  <p v-if="repositories.switching" class="repository-switch-notice glass-strong" role="status">正在准备切换仓库…</p>
  <div v-if="dataManagement.rollbackPath" class="restore-overlay" role="dialog" aria-modal="true" aria-labelledby="restore-pending-title">
    <section class="restore-panel glass-strong">
      <h2 id="restore-pending-title">备份已准备好，请重新启动</h2>
      <p>为保留当前草稿，恢复前已暂停编辑。重启后换入备份，并保留当前数据作为恢复历史。</p>
      <p v-if="dataManagement.error" role="alert">{{ dataManagement.error }}</p>
      <button ref="restoreButton" type="button" class="primary-button" :disabled="dataManagement.busy" @click="dataManagement.restart">重新启动并恢复</button>
    </section>
  </div>
  <CommandPalette v-else />
</template>

<style scoped>
.restore-overlay {
  position: fixed;
  inset: 0;
  z-index: 2500;
  display: grid;
  place-items: center;
  padding: var(--space-6);
  background: var(--fill);
}
.restore-panel {
  max-width: 540px;
  padding: var(--space-6);
  border-radius: var(--radius-lg);
  line-height: 1.6;
}
.restore-panel h2 {
  margin-top: 0;
}
.restore-panel p {
  margin-block: var(--space-4);
}
.repository-switch-notice {
  position: fixed;
  bottom: var(--space-5);
  left: 50%;
  z-index: 10;
  margin: 0;
  padding: var(--space-3) var(--space-5);
  border-radius: var(--radius-md);
  transform: translateX(-50%);
  pointer-events: none;
}
</style>
