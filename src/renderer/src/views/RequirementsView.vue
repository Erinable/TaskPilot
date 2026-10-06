<script setup lang="ts">
// Requirement center. Everything Product Lead wrote is rendered as text: it
// is model output and must never become markup.
import AppIcon from '@/components/AppIcon.vue';
import ComposeForm from '@/components/requirements/ComposeForm.vue';
import RequirementDetail from '@/components/requirements/RequirementDetail.vue';
import { useRequirementsStore } from '@/stores/requirements.ts';
import * as model from '@/components/requirements/requirement_model.ts';

const store = useRequirementsStore();
</script>

<template>
  <div class="view requirements-view">
    <aside class="req-list-pane glass" aria-label="需求列表">
      <div class="req-list-header">
        <h1>需求中心</h1>
        <button class="icon-button small" type="button" title="新建需求" aria-label="新建需求" @click="store.startCompose()"><AppIcon name="plus" /></button>
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
        <p>Product Lead 会澄清需求、拆解工作包，你确认后发布到工作队列。</p>
        <button class="primary-button" type="button" @click="store.startCompose()">
          <AppIcon name="plus" />
          新建需求
        </button>
      </div>
    </section>
  </div>
</template>
