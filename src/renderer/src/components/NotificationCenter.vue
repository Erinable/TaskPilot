<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';

import AppIcon from './AppIcon.vue';
import { relativeTime } from '@/lib/activity.ts';
import type { NotificationItem } from '@/lib/notifications.ts';
import { businessTimeZone } from '@/lib/time_zone.ts';
import { useNotificationsStore } from '@/stores/notifications.ts';

const store = useNotificationsStore();

const visible = ref(false);
const bell = ref<HTMLButtonElement | null>(null);

const bellLabel = computed(() => (store.unreadCount ? `通知（${store.unreadCount} 条未读）` : '通知'));

// Calendar-day labels follow the business time zone.
const timeOf = (item: NotificationItem) => (item.at ? relativeTime(item.at, new Date(), businessTimeZone()) : '');

// Fresh data each time the popover opens.
watch(visible, (shown) => {
  if (shown) store.refresh().catch((error) => console.error(error));
});

const close = () => {
  visible.value = false;
  bell.value?.focus();
};

const open = (item: NotificationItem) => {
  visible.value = false;
  store.openItem(item).catch((error) => console.error(error));
};

onMounted(() => store.startAutoRefresh());
onUnmounted(() => store.stopAutoRefresh());
</script>

<template>
  <el-popover v-model:visible="visible" trigger="click" placement="bottom-end" :width="380" role="dialog" popper-class="notification-popper glass-strong">
    <template #reference>
      <button ref="bell" class="icon-button" type="button" title="通知" :aria-label="bellLabel">
        <AppIcon name="bell" />
        <span v-if="store.unreadCount" class="notification-dot" data-unread-dot></span>
      </button>
    </template>
    <div class="notification-center" @keydown.escape.stop="close">
      <div class="notification-header">
        <h2>通知</h2>
        <el-button link type="primary" size="small" :disabled="!store.unreadCount" data-mark-all @click="store.markAllRead()">全部标为已读</el-button>
      </div>
      <p v-if="!store.items.length" class="empty-hint notification-empty">没有需要你处理的事项。</p>
      <ul v-else class="notification-list">
        <li v-for="item in store.items" :key="item.id">
          <button
            class="notification-item"
            :class="[item.tone, { unread: !store.isRead(item.id) }]"
            type="button"
            :data-notification="item.id"
            @click="open(item)"
          >
            <span class="notification-mark" aria-hidden="true"></span>
            <span class="notification-body">
              <strong class="notification-title">{{ item.title }}</strong>
              <span class="notification-text">{{ item.text }}</span>
            </span>
            <time v-if="timeOf(item)" class="notification-time" :datetime="item.at ?? undefined">{{ timeOf(item) }}</time>
            <span v-if="!store.isRead(item.id)" class="sr-only">未读</span>
          </button>
        </li>
      </ul>
    </div>
  </el-popover>
</template>

<style scoped>
.notification-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 6px 10px;
  border-bottom: 1px solid var(--line-soft);
}
.notification-header h2 {
  margin: 0;
  font-size: 15px;
  font-weight: 700;
  color: var(--text);
}
.notification-empty {
  padding: 24px 6px;
  text-align: center;
  font-size: 14px;
}
.notification-list {
  max-height: 420px;
  overflow-y: auto;
  margin: 6px 0 0;
  padding: 0;
  list-style: none;
}
.notification-item {
  width: 100%;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 8px;
  text-align: left;
  color: var(--text-secondary);
  background: none;
  border: 0;
  border-radius: 9px;
  cursor: pointer;
  font: inherit;
}
.notification-item:hover,
.notification-item:focus-visible {
  background: var(--fill-hover);
  outline: none;
}
.notification-item:focus-visible {
  box-shadow: 0 0 0 2px var(--accent);
}
.notification-mark {
  flex: none;
  width: 8px;
  height: 8px;
  margin-top: 6px;
  border-radius: 50%;
  background: transparent;
}
.notification-item.unread .notification-mark {
  background: var(--accent);
}
.notification-item.unread.danger .notification-mark {
  background: var(--danger);
}
.notification-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.notification-title {
  overflow: hidden;
  color: var(--text);
  font-size: 14px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.notification-item:not(.unread) .notification-title {
  font-weight: 500;
  color: var(--text-secondary);
}
.notification-text {
  font-size: 14px;
  overflow-wrap: anywhere;
}
.notification-time {
  flex: none;
  color: var(--text-tertiary);
  font-size: 14px;
  white-space: nowrap;
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
</style>

<style>
/* The popover is teleported to body; only its own surface is styled here. */
.el-popover.notification-popper {
  padding: 10px;
  border: 1px solid var(--glass-border);
  border-radius: 14px;
}
</style>
