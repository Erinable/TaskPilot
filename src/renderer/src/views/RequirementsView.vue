<script setup lang="ts">
// Requirement center. Everything Product Lead wrote is rendered as text: it
// is model output and must never become markup.
import { onUnmounted } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import ComposeForm from '@/components/requirements/ComposeForm.vue';
import RequirementDetail from '@/components/requirements/RequirementDetail.vue';
import { useRequirementsStore } from '@/stores/requirements.ts';
import * as model from '@/components/requirements/requirement_model.ts';

const store = useRequirementsStore();
onUnmounted(() => store.stopWatching());
</script>

<template>
  <div class="view requirements-view">
    <aside class="req-list-pane glass" aria-label="需求列表">
      <div class="req-list-header">
        <h1>需求中心</h1>
        <div class="req-list-actions">
          <button class="icon-button small" type="button" title="我想学…" aria-label="我想学…" data-action="learn" @click="store.startCompose('course')">
            <AppIcon name="flask" />
          </button>
          <button class="icon-button small" type="button" title="新建需求" aria-label="新建需求" @click="store.startCompose()"><AppIcon name="plus" /></button>
        </div>
      </div>
      <div class="req-list" role="list">
        <p v-if="store.items.length === 0" class="empty-hint">
          <AppIcon name="inbox" />
          还没有需求
        </p>
        <button
          v-for="item in store.items"
          :key="item.id"
          class="req-row"
          :class="{ active: item.id === store.selectedId && !store.composing }"
          type="button"
          role="listitem"
          :data-id="item.id"
          @click="store.select(item.id)"
        >
          <span class="req-row-title">{{ model.rowTitle(item) }}</span>
          <span class="req-row-meta">
            <span v-if="model.isCourse(item)" class="scope-badge selected">学</span>
            <span class="status-pill" :class="model.STATUS_TONES[item.status]">{{ model.STATUS_LABELS[item.status] }}</span>
            <time>{{ model.rowDate(item.updatedAt) }}</time>
            <AppIcon v-if="model.isRunning(item)" name="spinner" class="spin" />
          </span>
        </button>
      </div>
    </aside>

    <section class="req-detail" aria-live="polite">
      <ComposeForm v-if="store.pane === 'new'" />
      <RequirementDetail v-else-if="store.pane === 'detail' && store.current" :key="store.detailRevision" :item="store.current" />
      <div v-else-if="store.pane === 'empty'" class="req-pane req-empty" data-pane="empty">
        <span class="req-empty-icon"><AppIcon name="sparkle" /></span>
        <h2>从一个需求开始</h2>
        <p>Product Lead 会澄清需求、拆解工作包，你确认后发布到工作队列。想学一门知识，就从「我想学…」开始，Tutor 会帮你排出学习路径。</p>
        <div class="req-actions">
          <button class="primary-button" type="button" @click="store.startCompose()">
            <AppIcon name="plus" />
            我想做…
          </button>
          <button class="secondary-button" type="button" data-action="learn" @click="store.startCompose('course')">
            <AppIcon name="flask" />
            我想学…
          </button>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.req-list-actions {
  display: flex;
  gap: var(--space-1);
}
</style>
