<script setup lang="ts">
// The engineering map: Architect's module summaries from every requirement,
// beside the tracked file tree. Reads stored data only; no model calls.
import { computed, onMounted, ref } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import MapFileTree from '@/components/map/MapFileTree.vue';
import MapModuleDetail from '@/components/map/MapModuleDetail.vue';
import MapModuleList from '@/components/map/MapModuleList.vue';
import MapNotes from '@/components/map/MapNotes.vue';
import { call } from '@/lib/ipc.ts';
import { describeError } from '@/lib/errors.ts';
import { businessTimeZone } from '@/lib/time_zone.ts';
import { useRequirementsStore } from '@/stores/requirements.ts';
import { useSettingsStore } from '@/stores/settings.ts';
import type * as ipc from '@shared/ipc_types.ts';

const requirements = useRequirementsStore();
const settings = useSettingsStore();

const map = ref<ipc.EngineeringMap | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
const selectedPath = ref<string | null>(null);

const modulesByPath = computed(() => new Map((map.value?.modules ?? []).map((module) => [module.path, module])));
const summarized = computed(() => new Set(modulesByPath.value.keys()));
const selectedModule = computed(() => (selectedPath.value ? (modulesByPath.value.get(selectedPath.value) ?? null) : null));
const timeZone = businessTimeZone();

const load = async () => {
  loading.value = true;
  try {
    map.value = await call(window.taskpilot.engineeringMap.get());
    error.value = null;
  } catch (caught) {
    console.error(caught);
    error.value = describeError(caught);
  } finally {
    loading.value = false;
  }
};

const select = (path: string) => {
  selectedPath.value = path;
};

const openSource = (id: string) => {
  requirements.open({ id }).catch((caught) => console.error(caught));
};

const openRepositorySettings = () => {
  settings.open('repository').catch((caught) => console.error(caught));
};

onMounted(() => {
  load().catch((caught) => console.error(caught));
});
</script>

<template>
  <div class="view map-view">
    <div class="page-heading">
      <div>
        <h1>工程地图</h1>
        <p>汇总 Architect 在各需求里读过的模块接口；文件改动后会标为「可能过时」</p>
      </div>
      <div class="heading-actions">
        <button
          class="icon-button"
          type="button"
          aria-label="刷新"
          title="刷新"
          :disabled="loading"
          data-action="refresh"
          @click="load().catch((caught) => console.error(caught))"
        >
          <AppIcon :name="loading ? 'spinner' : 'refresh'" />
        </button>
      </div>
    </div>

    <p v-if="error" class="empty-hint glass map-error" data-error>
      <AppIcon name="alert" />
      {{ error }}
    </p>

    <div v-else-if="map && map.modules.length === 0" class="req-empty" data-empty="modules">
      <span class="req-empty-icon"><AppIcon name="map" /></span>
      <h2>还没有模块摘要</h2>
      <p>在需求澄清阶段，Architect 读过相关代码后，会把模块接口摘要汇总到这里。</p>
      <p v-if="map.files.length === 0" data-empty="workspace">还没有可读取的仓库文件，请先配置工作区仓库。</p>
      <div class="map-empty-actions">
        <button class="primary-button" type="button" @click="requirements.open({ compose: true })">
          <AppIcon name="plus" />
          去写需求
        </button>
        <button v-if="map.files.length === 0" class="secondary-button" type="button" data-action="settings" @click="openRepositorySettings">
          <AppIcon name="settings" />
          去设置仓库
        </button>
      </div>
    </div>

    <div v-else-if="map" class="map-columns">
      <section class="panel glass map-tree-panel">
        <div class="panel-heading">
          <div>
            <h2>仓库文件</h2>
            <p>已跟踪的文件；已摘要的文件高亮显示</p>
          </div>
        </div>
        <div v-if="map.files.length === 0" class="map-no-workspace" data-empty="workspace">
          <p class="empty-hint">
            <AppIcon name="info" />
            还没有可读取的仓库文件，请先配置工作区仓库。
          </p>
          <button class="secondary-button" type="button" data-action="settings" @click="openRepositorySettings">
            <AppIcon name="settings" />
            去设置仓库
          </button>
        </div>
        <MapFileTree v-else :files="map.files" :summarized="summarized" :truncated="map.truncated" @select="select" />
      </section>

      <div class="map-side">
        <section class="panel glass map-detail-panel">
          <div class="panel-heading">
            <div>
              <h2>{{ selectedModule ? '模块接口' : '全部模块' }}</h2>
              <p>{{ selectedModule ? '来自 Architect 的摘要' : `共 ${map.modules.length} 个已摘要模块` }}</p>
            </div>
            <button v-if="selectedPath" class="secondary-button" type="button" data-action="back" @click="selectedPath = null">全部模块</button>
          </div>
          <MapModuleDetail v-if="selectedModule" :module="selectedModule" :known="summarized" :time-zone="timeZone" @select="select" @source="openSource" />
          <template v-else>
            <p v-if="selectedPath" class="empty-hint" data-empty="unsummarized">
              <AppIcon name="info" />
              {{ selectedPath }} 还没有摘要
            </p>
            <MapModuleList :modules="map.modules" @select="select" />
          </template>
        </section>
        <MapNotes title="项目约定" kind="conventions" :notes="map.conventions" :time-zone="timeZone" @source="openSource" />
        <MapNotes title="待补充" kind="gaps" :notes="map.gaps" :time-zone="timeZone" @source="openSource" />
      </div>
    </div>

    <p v-else class="empty-hint" data-loading>
      <AppIcon name="spinner" />
      正在读取工程地图…
    </p>
  </div>
</template>

<style scoped>
.map-columns {
  display: grid;
  grid-template-columns: minmax(280px, 2fr) minmax(320px, 3fr);
  gap: 20px;
  align-items: start;
}
.map-side {
  display: flex;
  flex-direction: column;
  gap: 20px;
  min-width: 0;
}
.map-tree-panel,
.map-detail-panel {
  min-width: 0;
}
.map-no-workspace {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
  padding: 0 20px 20px;
}
.map-no-workspace .empty-hint {
  padding: 0;
}
.map-empty-actions {
  display: flex;
  gap: 10px;
  justify-content: center;
}
.map-error {
  border-radius: var(--radius-lg);
  color: var(--danger);
}
.empty-hint,
.panel-heading p,
.req-empty p {
  font-size: 14px;
}
</style>
