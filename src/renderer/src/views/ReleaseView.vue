<script setup lang="ts">
// Release page. Release Manager only proposes; TaskPilot never tags, commits,
// pushes or runs release commands. Model and repository text is text only.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import ReleaseDraftPanel from '@/components/release/ReleaseDraftPanel.vue';
import ReleaseHistory from '@/components/release/ReleaseHistory.vue';
import MilestonePanel from '@/components/release/MilestonePanel.vue';
import { useRequirementsStore } from '@/stores/requirements.ts';
import { describeErrorInfo } from '@/lib/errors.ts';
import * as model from '@/lib/release_model.ts';
import { useReleaseStore } from '@/stores/release.ts';
import { useSettingsStore } from '@/stores/settings.ts';
import type * as ipc from '@shared/ipc_types.ts';

const store = useReleaseStore();
const settings = useSettingsStore();
const requirements = useRequirementsStore();

const startPoint = computed(() => store.state?.startPoint ?? null);
const draft = computed(() => store.draft);
const readyDraft = computed(() => (draft.value?.status === 'ready' && draft.value.plan ? (draft.value as ipc.ReleaseDraft & { plan: ipc.ReleasePlan }) : null));
const commitOptions = computed(() => (store.commits ?? []).map((commit) => ({ value: commit.sha, label: model.commitOptionLabel(commit) })));

const run = (action: () => Promise<unknown>) => {
  action().catch((error) => console.error(error));
};
const openRepositorySettings = () => run(() => settings.open('repository'));
// Covers the gap between the click and the draft reporting it is generating.
const starting = ref(false);
const generate = () => {
  starting.value = true;
  store
    .generate()
    .catch((error) => console.error(error))
    .finally(() => (starting.value = false));
};

// A finished version plan starts the draft and scrolls to it.
const startPanel = ref<HTMLElement | null>(null);
const draftFromMilestone = () => {
  startPanel.value?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (!store.generating && !draft.value) generate();
};

onMounted(() => {
  run(store.enter);
  // The plan form lists requirements by title.
  run(requirements.refreshList);
});
onBeforeUnmount(() => store.leave());
</script>

<template>
  <div class="view release-view">
    <div class="page-heading">
      <div>
        <h1>发布</h1>
        <p class="release-intro">
          Release Manager 根据上次发布以来的提交和完成的工作包，起草版本号、更新说明和发布前检查清单。TaskPilot 不会打 tag、提交或推送。
        </p>
      </div>
    </div>

    <p v-if="store.loadError" class="empty-hint load-error">
      <AppIcon name="alert" />
      读取发布信息失败：{{ store.loadError }}
      <button class="empty-action" type="button" @click="run(store.load)">重试</button>
    </p>

    <div v-if="store.state && !store.state.configured" class="panel glass req-empty no-workspace">
      <span class="req-empty-icon"><AppIcon name="folder" /></span>
      <h2>还没有仓库</h2>
      <p>发布需要读取仓库的提交记录，请先添加一个仓库。</p>
      <button class="primary-button" type="button" @click="openRepositorySettings">
        <AppIcon name="settings" />
        前往仓库设置
      </button>
    </div>

    <template v-else-if="store.state && startPoint">
      <MilestonePanel @draft="draftFromMilestone" />
      <section ref="startPanel" class="panel glass release-start" aria-label="起点">
        <div class="start-row">
          <span class="panel-icon"><AppIcon name="git-branch" /></span>
          <p v-if="startPoint.kind !== 'none'" class="start-line">{{ model.startPointLine(startPoint, draft?.input ?? null) }}</p>
          <div v-else class="start-pick">
            <label for="release-start-commit" class="start-label">还没有发布记录或标签，从哪个提交开始？</label>
            <el-select
              id="release-start-commit"
              :model-value="store.selectedStart ?? undefined"
              class="start-select"
              filterable
              placeholder="选择起始提交"
              :loading="store.commits === null"
              aria-label="起始提交"
              :disabled="store.generating"
              @update:model-value="store.selectStart"
            >
              <el-option v-for="option in commitOptions" :key="option.value" :label="option.label" :value="option.value" />
            </el-select>
          </div>
          <div class="start-actions">
            <template v-if="store.generating">
              <span class="generating" role="status">
                <AppIcon name="spinner" class="spin" />
                Release Manager 正在起草…
              </span>
              <button class="secondary-button cancel-release" type="button" @click="run(store.cancel)">取消</button>
            </template>
            <button v-else class="primary-button generate-release" type="button" :disabled="starting" :aria-busy="starting" @click="generate">
              <AppIcon v-if="starting" name="spinner" class="spin" />
              <AppIcon v-else :name="draft?.status === 'failed' ? 'refresh' : 'sparkle'" />
              {{ draft?.status === 'failed' ? '重试' : draft ? '重新生成' : '生成' }}
            </button>
          </div>
        </div>
        <p v-if="store.startError" class="start-error" role="alert">{{ store.startError }}</p>
        <p v-if="draft?.status === 'failed'" class="draft-error" role="alert">
          <AppIcon name="alert" />
          {{ describeErrorInfo(draft.error) || '生成失败。' }}
        </p>
      </section>

      <ReleaseDraftPanel v-if="readyDraft" :draft="readyDraft" />

      <ReleaseHistory :releases="store.state.history" />
    </template>
  </div>
</template>

<style scoped>
.release-intro {
  font-size: var(--text-sm);
}
.release-view > .panel + .panel,
.release-view :deep(.panel + .panel) {
  margin-top: 16px;
}
.release-start {
  padding: 16px 20px;
}
.start-row {
  display: flex;
  align-items: center;
  gap: 12px;
}
.start-line {
  flex: 1;
  margin: 0;
  color: var(--text);
  font-size: var(--text-sm);
}
.start-pick {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.start-label {
  color: var(--text-secondary);
  font-size: var(--text-sm);
}
.start-select {
  max-width: 520px;
}
.start-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}
.generating {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text-muted);
  font-size: var(--text-sm);
}
.generating .icon {
  width: 15px;
  height: 15px;
}
.start-error,
.draft-error {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 10px 0 0;
  color: var(--danger);
  font-size: var(--text-sm);
}
.draft-error .icon {
  width: 15px;
  height: 15px;
}
.primary-button,
.secondary-button {
  font-size: var(--text-sm);
}
.load-error {
  font-size: var(--text-sm);
}
/* .req-empty only pads the top (it was made for full pages); inside a panel
   that clips, the button would sit on the bottom border. */
.no-workspace {
  padding: 48px 24px;
}
.no-workspace h2 {
  font-size: var(--text-lg);
}
.no-workspace p {
  font-size: var(--text-sm);
}
</style>
