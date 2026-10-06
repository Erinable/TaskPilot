<script setup lang="ts">
import { computed, ref } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import { useAppStore } from '@/stores/app.ts';
import { useTasksStore } from '@/stores/tasks.ts';
import { useRequirementsStore } from '@/stores/requirements.ts';
import { useExecutionStore } from '@/stores/execution.ts';
import * as activity from '@/lib/activity.ts';
import { businessTimeZone } from '@/lib/time_zone.ts';
import { FILTER_OPTIONS, countByFilter, filterQueue } from '@/lib/queue_filter.ts';
import type { QueueFilter } from '@/lib/queue_filter.ts';
import type { IconName } from '@/lib/icons.ts';

const PRIORITY_LABELS: Record<string, string> = { high: '高优先级', medium: '中优先级', low: '低优先级' };

const app = useAppStore();
const tasks = useTasksStore();
const requirements = useRequirementsStore();
const execution = useExecutionStore();

// Greeting and date follow the business time zone, like every day label.
const now = new Date();
const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: businessTimeZone(), hour: 'numeric', hourCycle: 'h23' }).format(now));
const greeting = hour < 12 ? '早上好' : hour < 18 ? '下午好' : '晚上好';
const todayLabel = new Intl.DateTimeFormat('zh-CN', { timeZone: businessTimeZone(), weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }).format(
  now,
);
const greetingName = computed(() => (app.preferences?.profile.displayName ? `，${app.preferences.profile.displayName}` : ''));

// Done packages leave the default view; the filter brings them back.
const filter = ref<QueueFilter>('active');
const visibleTasks = computed(() => filterQueue(tasks.tasks, filter.value));
const filterCounts = computed(() => countByFilter(tasks.tasks));
const filterLabel = computed(() => FILTER_OPTIONS.find((option) => option.value === filter.value)?.label);

const overview = computed(() => app.activity);
const feed = computed(() => {
  const current = overview.value;
  if (!current) return [];
  const at = new Date();
  return current.recent.slice(0, 6).map((record, index) => {
    const item = activity.toFeedItem(record, index);
    return { ...item, time: activity.relativeTime(item.at, at, businessTimeZone()) };
  });
});
const doneTrend = computed(() => (overview.value ? activity.doneTrend(overview.value.metrics) : null));
const durationTrend = computed(() => (overview.value ? activity.durationTrend(overview.value.metrics) : null));
const presenceSummary = computed(() => activity.presenceSummary(overview.value?.team ?? null));
const teamOnline = computed(() => overview.value?.team.available === true);
</script>

<template>
  <div class="view">
    <div class="page-heading">
      <div>
        <div class="eyebrow">{{ todayLabel }}</div>
        <h1>
          <span>{{ greeting }}</span>
          <span>{{ greetingName }}</span>
          <AppIcon name="sparkle" class="wave" />
        </h1>
        <p>AI 团队正在协作，你负责把已验证的指令写进代码。</p>
      </div>
      <div class="heading-actions">
        <div v-if="presenceSummary" class="team-presence" :class="{ offline: !teamOnline }">
          <span></span>
          {{ presenceSummary }}
        </div>
        <button class="primary-button" @click="requirements.open({ compose: true })">
          <AppIcon name="plus" />
          新建需求
        </button>
      </div>
    </div>

    <section class="metrics-row">
      <div class="metric-card glass">
        <div class="metric-icon accent"><AppIcon name="inbox" /></div>
        <div>
          <span>待处理工作包</span>
          <strong>{{ tasks.pendingCount }}</strong>
        </div>
      </div>
      <div class="metric-card glass">
        <div class="metric-icon success"><AppIcon name="check-circle" /></div>
        <div>
          <span>本周已完成</span>
          <strong>{{ overview ? overview.metrics.doneThisWeek : '–' }}</strong>
        </div>
        <small v-if="doneTrend" class="metric-trend" :class="doneTrend.tone">
          <AppIcon v-if="doneTrend.tone === 'up'" name="trend-up" />
          {{ doneTrend.text }}
        </small>
      </div>
      <div class="metric-card glass" title="从领取到完成的平均时长，近 7 天">
        <div class="metric-icon warning"><AppIcon name="clock" /></div>
        <div>
          <span>平均执行时长</span>
          <strong>{{ overview ? activity.formatHours(overview.metrics.averageHours) : '–' }}</strong>
        </div>
        <small v-if="durationTrend" class="metric-trend" :class="durationTrend.tone">
          <AppIcon v-if="durationTrend.tone === 'up'" name="trend-up" />
          {{ durationTrend.text }}
        </small>
      </div>
    </section>

    <div class="content-columns">
      <section class="queue-panel panel glass">
        <div class="panel-heading">
          <div>
            <h2>你的工作队列</h2>
            <p>按优先级排序的编码工作包</p>
          </div>
          <el-dropdown
            trigger="click"
            @command="
              (value: QueueFilter) => {
                filter = value;
              }
            "
          >
            <button class="filter-button" type="button" :aria-label="`筛选：${filterLabel}`">
              <AppIcon name="filter" />
              {{ filterLabel }}
            </button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item
                  v-for="option in FILTER_OPTIONS"
                  :key="option.value"
                  :command="option.value"
                  :class="{ 'is-active': option.value === filter }"
                >
                  {{ option.label }}
                  <span class="filter-count">{{ filterCounts[option.value] }}</span>
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
        <div class="task-list">
          <!-- The queue only holds published packages, so point an empty one at the requirement center. -->
          <div v-if="tasks.tasks.length === 0" class="req-empty" data-empty="queue">
            <span class="req-empty-icon"><AppIcon name="inbox" /></span>
            <h2>还没有工作包</h2>
            <p>在需求中心描述需求，Product Lead 拆解并经你确认后，工作包会出现在这里。</p>
            <button class="primary-button" type="button" @click="requirements.open({ compose: true })">
              <AppIcon name="plus" />
              去写需求
            </button>
          </div>
          <p v-else-if="visibleTasks.length === 0" class="empty-hint" data-empty="filter">
            <AppIcon name="filter" />
            没有「{{ filterLabel }}」的工作包
          </p>
          <button v-for="task in visibleTasks" :key="task.id" class="task-item" type="button" @click="execution.open(task.id)">
            <!-- task.icon comes from tasks.ts; an unknown name renders blank. -->
            <div class="task-state" :class="`priority-${task.priority}`"><AppIcon :name="task.icon as IconName" /></div>
            <div class="task-main">
              <div class="task-title">{{ task.title }}</div>
              <div class="task-description">{{ task.description }}</div>
              <div class="task-tags">
                <span class="status-pill" :class="task.status">{{ task.statusLabel }}</span>
                <span v-for="tag in task.tags" :key="tag" class="tag">{{ tag }}</span>
              </div>
            </div>
            <div class="task-side">
              <div class="task-side-meta">
                <span class="priority">
                  <span class="priority-dot" :class="task.priority"></span>
                  {{ PRIORITY_LABELS[task.priority] }}
                </span>
                <span class="task-time">
                  <AppIcon name="clock" />
                  {{ task.estimate }}
                </span>
              </div>
              <AppIcon name="chevron-right" class="task-go" />
            </div>
          </button>
        </div>
        <button v-if="filter !== 'all' && tasks.tasks.length > visibleTasks.length" class="view-all-button" type="button" @click="filter = 'all'">
          查看全部 {{ tasks.tasks.length }} 个工作包
          <AppIcon name="arrow-right" />
        </button>
      </section>

      <section class="activity-panel panel glass">
        <div class="panel-heading">
          <div>
            <h2>AI 团队动态</h2>
            <p>项目上下文正在持续更新</p>
          </div>
          <button class="icon-button small" aria-label="更多"><AppIcon name="more" /></button>
        </div>
        <div class="activity-list">
          <div v-for="item in feed" :key="item.key" class="activity-item">
            <span class="activity-avatar" :class="item.actor.avatar">{{ item.actor.initials }}</span>
            <div>
              <p>
                <strong>{{ item.actor.name }}</strong>
                {{ item.what }}
              </p>
              <small>{{ item.detail }}</small>
              <time :datetime="item.at">{{ item.time }}</time>
            </div>
          </div>
          <p v-if="overview && feed.length === 0" class="empty-hint">
            <AppIcon name="activity" />
            还没有动态。提交需求或推进工作包后会出现在这里。
          </p>
        </div>
        <button class="view-all-button" @click="app.navigate('activity')">
          查看完整活动记录
          <AppIcon name="arrow-right" />
        </button>
      </section>
    </div>
  </div>
</template>

<style scoped>
/* A falling trend, and the presence chip when the team is unreachable. */
.metric-trend.down {
  color: var(--danger);
  background: var(--danger-soft);
}
.team-presence.offline span {
  background: var(--text-tertiary);
  box-shadow: none;
  animation: none;
}
/* The requirement center's empty state sits lower; inside a panel it starts near the top. */
.task-list .req-empty {
  padding-top: 32px;
  padding-bottom: 24px;
}
.filter-count {
  margin-left: 12px;
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
}
:global(.el-dropdown-menu__item.is-active) {
  color: var(--accent);
  font-weight: 600;
}
</style>
