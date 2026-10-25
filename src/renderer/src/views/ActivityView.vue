<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { storeToRefs } from 'pinia';

import AppIcon from '@/components/AppIcon.vue';
import TeamTabs from '@/components/TeamTabs.vue';
import { businessDay, businessTimeZone, previousDay } from '@/lib/time_zone.ts';
import * as activity from '@/lib/activity.ts';
import { useActivityFeedStore } from '@/stores/activity_feed.ts';
import { useExecutionStore } from '@/stores/execution.ts';
import { useRequirementsStore } from '@/stores/requirements.ts';
import { useTasksStore } from '@/stores/tasks.ts';
import type * as ipc from '@shared/ipc_types.ts';

type Who = 'all' | 'you' | 'agents';

const WHO_OPTIONS: { value: Who; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'you', label: '我的操作' },
  { value: 'agents', label: 'AI 团队' },
];

const execution = useExecutionStore();
const requirements = useRequirementsStore();
const tasks = useTasksStore();

const feed = useActivityFeedStore();
const { days, nextBefore, retentionDays, loading, loaded, error } = storeToRefs(feed);
const who = ref<Who>('all');

const loadPage = (before: string | null) => feed.loadPage(before);

const dayLabel = (day: string) => {
  const today = businessDay(new Date());
  if (day === today) return '今天';
  if (day === previousDay(today)) return '昨天';
  return `${Number(day.slice(5, 7))} 月 ${Number(day.slice(8))} 日`;
};

const timeOf = (at: string) =>
  new Intl.DateTimeFormat('zh-CN', { timeZone: businessTimeZone(), hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(at));

const groups = computed(() =>
  days.value
    .map(({ day, records }) => ({
      day,
      label: dayLabel(day),
      items: records
        .map((record, index) => ({ record, item: activity.toFeedItem(record, index) }))
        .filter(({ item }) => who.value === 'all' || (who.value === 'you') === (item.actor.avatar === 'you'))
        .map(({ record, item }) => ({ ...item, time: timeOf(item.at), target: targetOf(record) })),
    }))
    .filter((group) => group.items.length > 0),
);

// Where clicking an event goes: the package if it still exists, else the requirement.
const targetOf = (record: ipc.ActivityRecord) => {
  if (record.kind === 'package_transition') {
    return tasks.tasks.some((task) => task.id === record.packageId) ? { kind: 'package' as const, id: record.packageId } : null;
  }
  if (record.kind === 'coding_run') return tasks.tasks.some((task) => task.id === record.packageId) ? { kind: 'package' as const, id: record.packageId } : null;
  if (record.kind === 'release_finished') return null;
  return requirements.items.some((item) => item.id === record.requirementId) ? { kind: 'requirement' as const, id: record.requirementId } : null;
};

const openTarget = (target: { kind: 'package' | 'requirement'; id: string }) => {
  const opening = target.kind === 'package' ? execution.open(target.id) : requirements.open({ id: target.id });
  opening.catch((caught) => console.error(caught));
};

onMounted(() => feed.open());
</script>

<template>
  <div class="view activity-view">
    <TeamTabs />
    <div class="page-heading">
      <div>
        <h1>活动记录</h1>
        <p>你和 AI 团队对工作包、需求的每一次推进。保留最近 {{ retentionDays || 30 }} 天。</p>
      </div>
      <div class="heading-actions">
        <el-segmented v-model="who" :options="WHO_OPTIONS" aria-label="按操作者筛选" />
        <button class="icon-button" type="button" title="刷新" aria-label="刷新活动记录" :disabled="loading" @click="loadPage(null)">
          <AppIcon :name="loading ? 'spinner' : 'refresh'" :class="{ spin: loading }" />
        </button>
      </div>
    </div>

    <section class="panel glass activity-panel">
      <p v-if="error" class="empty-hint">
        <AppIcon name="alert" />
        读取活动记录失败：{{ error }}
        <button class="empty-action" type="button" :disabled="loading" @click="loadPage(null)">重试</button>
      </p>
      <div v-else-if="loaded && groups.length === 0 && !nextBefore" class="req-empty activity-empty" data-empty="activity">
        <span class="req-empty-icon"><AppIcon name="activity" /></span>
        <h2>{{ who === 'all' ? '还没有动态' : '没有匹配的动态' }}</h2>
        <p>{{ who === 'all' ? '提交需求或推进工作包后，你和 AI 团队的每一步都会出现在这里。' : '这段时间没有这类成员的操作。' }}</p>
        <button
          v-if="who === 'all'"
          class="primary-button"
          type="button"
          @click="requirements.open({ compose: true }).catch((caught) => console.error(caught))"
        >
          <AppIcon name="plus" />
          新建需求
        </button>
        <button v-else class="secondary-button" type="button" @click="who = 'all'">查看全部成员</button>
      </div>
      <section v-for="group in groups" :key="group.day" class="activity-day" :aria-label="group.label">
        <h2 class="activity-day-label">{{ group.label }}</h2>
        <div class="activity-list">
          <component
            :is="item.target ? 'button' : 'div'"
            v-for="item in group.items"
            :key="item.key"
            class="activity-item"
            :class="{ clickable: item.target }"
            :type="item.target ? 'button' : undefined"
            @click="item.target && openTarget(item.target)"
          >
            <span class="activity-avatar" :class="item.actor.avatar">{{ item.actor.initials }}</span>
            <div>
              <p>
                <strong>{{ item.actor.name }}</strong>
                {{ item.what }}
              </p>
              <small>{{ item.detail }}</small>
              <time :datetime="item.at">{{ item.time }}</time>
            </div>
          </component>
        </div>
      </section>
      <button v-if="nextBefore" class="view-all-button" type="button" :disabled="loading" @click="loadPage(nextBefore)">
        {{ loading ? '加载中…' : '加载更早的动态' }}
        <AppIcon name="arrow-right" />
      </button>
    </section>
  </div>
</template>

<style scoped>
/* Same centered empty state as the queue and the map, sized for a panel. */
.activity-empty {
  padding: 40px 0 32px;
}
.activity-empty h2 {
  font-size: var(--text-lg);
}
.activity-panel {
  padding: 8px 24px 16px;
}
.activity-day + .activity-day {
  margin-top: 8px;
}
.activity-day-label {
  margin: 16px 0 4px;
  color: var(--text-muted);
  font-size: var(--text-sm);
  font-weight: 600;
}
.activity-item.clickable {
  width: 100%;
  text-align: left;
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.activity-item.clickable:hover {
  background: var(--fill-hover);
}
.activity-item p,
.activity-item small {
  font-size: var(--text-sm);
}
</style>
