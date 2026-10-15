<script setup lang="ts">
import { computed, ref } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import DifficultyChip from '@/components/DifficultyChip.vue';
import OnboardingChecklist from '@/components/OnboardingChecklist.vue';
import { useAppStore } from '@/stores/app.ts';
import { useTasksStore } from '@/stores/tasks.ts';
import { useRequirementsStore } from '@/stores/requirements.ts';
import { useExecutionStore } from '@/stores/execution.ts';
import * as activity from '@/lib/activity.ts';
import { businessTimeZone } from '@/lib/time_zone.ts';
import { FILTER_OPTIONS, countByFilter, filterQueue } from '@/lib/queue_filter.ts';
import type { QueueFilter } from '@/lib/queue_filter.ts';
import { LAYOUT_STORAGE_KEY, actionOf, estimateAccuracy, readLayout, timeText } from '@/lib/board.ts';
import type { QueueLayout } from '@/lib/board.ts';
import QueueBoard from '@/components/queue/QueueBoard.vue';
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
// Board or list, remembered on this machine.
const layout = ref<QueueLayout>(readLayout(globalThis.localStorage));
const setLayout = (next: QueueLayout) => {
  layout.value = next;
  globalThis.localStorage?.setItem(LAYOUT_STORAGE_KEY, next);
};
// The board shows every stage; done cards stay in their column.
const boardTasks = computed(() => filterQueue(tasks.tasks, 'all'));
const accuracy = computed(() => estimateAccuracy(tasks.tasks));
const doneTrend = computed(() => (overview.value ? activity.doneTrend(overview.value.metrics) : null));
const durationTrend = computed(() => (overview.value ? activity.durationTrend(overview.value.metrics) : null));
const presenceSummary = computed(() => activity.presenceSummary(overview.value?.team ?? null));
const teamOnline = computed(() => overview.value?.team.available === true);
// Weekly numbers mean nothing before the first package is finished.
const hasHistory = computed(() => tasks.tasks.some((task) => task.status === 'done') || (overview.value?.metrics.doneThisWeek ?? 0) > 0);
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
        <p>写下想做的功能，AI 团队负责拆解、写代码和检查，每个关键决定都由你点头。</p>
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

    <OnboardingChecklist />

    <section v-if="hasHistory" class="metrics-row">
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
      <div class="metric-card glass" title="实际用时在预计的 0.5 到 1.5 倍之间的已完成工作包占比">
        <div class="metric-icon accent"><AppIcon name="target" /></div>
        <div>
          <span>估时准确度</span>
          <strong>{{ accuracy ? `${Math.round(accuracy.ratio * 100)}%` : '–' }}</strong>
        </div>
        <small class="metric-trend">{{ accuracy ? `基于 ${accuracy.count} 个已完成` : '完成第一个工作包后统计' }}</small>
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

    <div class="content-columns" :class="{ 'board-layout': layout === 'board' }">
      <section class="queue-panel panel glass">
        <div class="panel-heading">
          <div>
            <h2>你的工作队列</h2>
            <p>{{ layout === 'board' ? '按阶段排列，每张卡片上是下一步该做的事' : '按优先级排序的编码工作包' }}</p>
          </div>
          <div class="queue-tools">
            <div class="layout-toggle" role="group" aria-label="队列显示方式">
              <button type="button" :class="{ active: layout === 'board' }" :aria-pressed="layout === 'board'" title="看板" @click="setLayout('board')">
                <AppIcon name="board" />
                <span>看板</span>
              </button>
              <button type="button" :class="{ active: layout === 'list' }" :aria-pressed="layout === 'list'" title="列表" @click="setLayout('list')">
                <AppIcon name="list" />
                <span>列表</span>
              </button>
            </div>
            <el-dropdown
              v-if="layout === 'list'"
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
        </div>
        <QueueBoard v-if="layout === 'board' && tasks.tasks.length" :tasks="boardTasks" />
        <div v-else class="task-list">
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
            <button class="empty-action" type="button" @click="filter = 'all'">查看全部</button>
          </p>
          <button v-for="task in visibleTasks" :key="task.id" class="task-item" type="button" @click="execution.open(task.id)">
            <!-- task.icon comes from tasks.ts; an unknown name falls back to the package icon. -->
            <div class="task-state" :class="`priority-${task.priority}`"><AppIcon :name="task.icon as IconName" /></div>
            <div class="task-main">
              <div class="task-title">{{ task.title }}</div>
              <div class="task-description">{{ task.description }}</div>
              <div class="task-tags">
                <span class="status-pill" :class="task.status">{{ task.statusLabel }}</span>
                <span v-if="actionOf(task).label === '等待前置'" class="status-pill waiting">
                  <AppIcon name="clock" />
                  等待前置
                </span>
                <span v-for="tag in task.tags" :key="tag" class="tag">{{ tag }}</span>
              </div>
              <!-- Step progress once a package is underway. -->
              <div v-if="task.status !== 'pending' && task.steps.length > 0" class="task-progress" data-progress>
                <span class="progress-track" aria-hidden="true">
                  <span class="progress-fill" :style="{ width: `${(task.completedSteps.length / task.steps.length) * 100}%` }"></span>
                </span>
                <span>{{ task.completedSteps.length }} / {{ task.steps.length }} 步</span>
              </div>
            </div>
            <div class="task-side">
              <div class="task-side-meta">
                <span class="priority">
                  <span class="priority-dot" :class="task.priority"></span>
                  {{ PRIORITY_LABELS[task.priority] }}
                </span>
                <span class="task-time" :class="{ overrun: timeText(task)?.overrun }">
                  <AppIcon name="clock" />
                  {{ timeText(task)?.text ?? task.estimate }}
                </span>
                <DifficultyChip :difficulty="task.difficulty" />
              </div>
              <AppIcon name="chevron-right" class="task-go" />
            </div>
          </button>
        </div>
        <button
          v-if="layout === 'list' && filter !== 'all' && tasks.tasks.length > visibleTasks.length"
          class="view-all-button"
          type="button"
          @click="filter = 'all'"
        >
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
          <button class="icon-button small" type="button" title="查看完整活动记录" aria-label="查看完整活动记录" @click="app.navigate('activity')">
            <AppIcon name="arrow-right" />
          </button>
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
            <button class="empty-action" type="button" @click="requirements.open({ compose: true })">新建需求</button>
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
/* The board needs the full width; the team feed moves below it. */
.content-columns.board-layout {
  grid-template-columns: minmax(0, 1fr);
}
.metrics-row {
  grid-template-columns: repeat(4, minmax(0, 1fr));
}
@media (max-width: 1100px) {
  .metrics-row {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
.queue-tools {
  display: flex;
  gap: var(--space-2);
  align-items: center;
}
.layout-toggle {
  display: inline-flex;
  padding: 2px;
  border-radius: var(--radius-md);
  background: var(--fill);
}
.layout-toggle button {
  display: inline-flex;
  gap: var(--space-1);
  align-items: center;
  height: 28px;
  padding: 0 10px;
  border: 0;
  border-radius: calc(var(--radius-md) - 2px);
  color: var(--text-secondary);
  background: none;
  font-size: var(--text-sm);
  cursor: pointer;
}
.layout-toggle button.active {
  color: var(--text);
  background: var(--glass-bg-strong);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12);
}
.layout-toggle button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.layout-toggle .icon {
  width: 14px;
  height: 14px;
}
.status-pill.waiting {
  color: var(--text-secondary);
}
.status-pill.waiting::before {
  display: none;
}
.status-pill.waiting .icon {
  width: 11px;
  height: 11px;
}
.task-time.overrun {
  color: var(--warning);
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
