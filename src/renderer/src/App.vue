<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue';

import TopBar from './components/TopBar.vue';
import SideBar from './components/SideBar.vue';
import QueueView from './views/QueueView.vue';
import ExecutionView from './views/ExecutionView.vue';
import RequirementsView from './views/RequirementsView.vue';
import SettingsView from './views/SettingsView.vue';
import MapView from './views/MapView.vue';
import ActivityView from './views/ActivityView.vue';
import ReleaseView from './views/ReleaseView.vue';
import TeamView from './views/TeamView.vue';
import CostView from './views/CostView.vue';
import CommandPalette from './components/CommandPalette.vue';
import { useAppStore } from './stores/app.ts';
import { useTasksStore } from './stores/tasks.ts';
import { useRequirementsStore } from './stores/requirements.ts';
import { useSettingsStore } from './stores/settings.ts';
import { useExecutionStore } from './stores/execution.ts';
import { useNotificationsStore } from './stores/notifications.ts';
import { useRepositoriesStore } from './stores/repositories.ts';
import { useCodingActivityStore } from './stores/coding_activity.ts';
import { describeError } from './lib/errors.ts';
import { openDialogs, showToast } from './lib/feedback.ts';

const app = useAppStore();
const tasks = useTasksStore();
const requirements = useRequirementsStore();
const settings = useSettingsStore();
const execution = useExecutionStore();
const repositories = useRepositoriesStore();
const codingActivity = useCodingActivityStore();

// Dialogs (Element Plus) handle their own Escape; these are the page shortcuts.
const onKeydown = (event: KeyboardEvent) => {
  if (openDialogs.value > 0) return;
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

// Agents run in the background; presence and the feed follow them.
const ACTIVITY_POLL_MS = 15_000;

onMounted(async () => {
  document.addEventListener('keydown', onKeydown);
  app.startActivityPolling(ACTIVITY_POLL_MS);
  codingActivity.start();
  // Notification read state is per repository, so the list comes first.
  await repositories.refresh();
  useNotificationsStore().useRepository(repositories.currentId);
  requirements.init().catch((error) => console.error(error));
  try {
    await app.loadPreferences();
  } catch (error) {
    console.error('Failed to load preferences', error);
  }
  try {
    await tasks.reloadQueue();
  } catch (error) {
    console.error('Failed to load tasks', error);
    showToast(`工作包加载失败：${describeError(error)}`);
  }
  const info = await app.refreshWorkspaceStatus();
  if (info && !info.configured) showToast('还没有添加仓库，点顶栏的仓库菜单添加一个。', 'info');
});

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown);
  app.stopActivityPolling();
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

  <div class="window-shell">
    <TopBar />
    <div class="app-grid" :class="{ 'sidebar-collapsed': app.sidebarCollapsed }">
      <SideBar />
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
        </div>
        <!-- Settings stays mounted so unsaved drafts survive leaving and coming back. -->
        <SettingsView v-show="app.view === 'settings'" />
      </main>
    </div>
  </div>
  <CommandPalette />
</template>
