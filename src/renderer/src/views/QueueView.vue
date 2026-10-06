<script setup lang="ts">
import { computed } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import { useAppStore } from '@/stores/app.ts';
import { useTasksStore } from '@/stores/tasks.ts';
import { useRequirementsStore } from '@/stores/requirements.ts';
import { useExecutionStore } from '@/stores/execution.ts';
import type { IconName } from '@/lib/icons.ts';

const PRIORITY_LABELS: Record<string, string> = { high: '高优先级', medium: '中优先级', low: '低优先级' };

const app = useAppStore();
const tasks = useTasksStore();
const requirements = useRequirementsStore();
const execution = useExecutionStore();

const now = new Date();
const hour = now.getHours();
const greeting = hour < 12 ? '早上好' : hour < 18 ? '下午好' : '晚上好';
const todayLabel = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }).toUpperCase();
const greetingName = computed(() => (app.preferences?.profile.displayName ? `，${app.preferences.profile.displayName}` : ''));

const ACTIVITY = [
  { avatar: 'arch', initials: 'AR', who: 'Architect', what: '更新了架构决策', detail: '将 TokenService 移入 auth/infrastructure', time: '8 分钟前' },
  { avatar: 'qa', initials: 'QA', who: 'QA Partner', what: '完成测试分析', detail: '发现 2 个未覆盖的边界条件', time: '34 分钟前' },
  { avatar: 'pm', initials: 'PM', who: 'Product Lead', what: '澄清了需求', detail: '邮箱登录 · 验收标准已更新', time: '1 小时前' },
  { avatar: 'rel', initials: 'RM', who: 'Release Manager', what: '发布了 v0.8.0', detail: '登录模块 · 生产环境', time: '昨天' },
];
</script>

<template>
  <div class="view">
    <div class="page-heading">
      <div>
        <div class="eyebrow">{{ todayLabel }}</div>
        <h1><span>{{ greeting }}</span><span>{{ greetingName }}</span> <AppIcon name="sparkle" class="wave" /></h1>
        <p>AI 团队正在协作，你负责把已验证的指令写进代码。</p>
      </div>
      <div class="heading-actions">
        <div class="team-presence"><span></span> 4 个 AI 成员在线</div>
        <button class="primary-button" @click="requirements.open({ compose: true })"><AppIcon name="plus" />新建需求</button>
      </div>
    </div>

    <section class="metrics-row">
      <div class="metric-card glass"><div class="metric-icon accent"><AppIcon name="inbox" /></div><div><span>待处理工作包</span><strong>{{ tasks.pendingCount }}</strong></div><small class="metric-trend up"><AppIcon name="trend-up" />2 本周</small></div>
      <div class="metric-card glass"><div class="metric-icon success"><AppIcon name="check-circle" /></div><div><span>本周已完成</span><strong>12</strong></div><small class="metric-trend up"><AppIcon name="trend-up" />28%</small></div>
      <div class="metric-card glass"><div class="metric-icon warning"><AppIcon name="clock" /></div><div><span>平均执行时长</span><strong>2.4h</strong></div><small class="metric-trend neutral">较上周稳定</small></div>
    </section>

    <div class="content-columns">
      <section class="queue-panel panel glass">
        <div class="panel-heading"><div><h2>你的工作队列</h2><p>按优先级排序的编码工作包</p></div><button class="filter-button"><AppIcon name="filter" />全部状态</button></div>
        <div class="task-list">
          <button v-for="task in tasks.tasks" :key="task.id" class="task-item" type="button" @click="execution.open(task.id)">
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
                <span class="priority"><span class="priority-dot" :class="task.priority"></span>{{ PRIORITY_LABELS[task.priority] }}</span>
                <span class="task-time"><AppIcon name="clock" />{{ task.estimate }}</span>
              </div>
              <AppIcon name="chevron-right" class="task-go" />
            </div>
          </button>
        </div>
        <button class="view-all-button">查看全部工作包<AppIcon name="arrow-right" /></button>
      </section>

      <section class="activity-panel panel glass">
        <div class="panel-heading"><div><h2>AI 团队动态</h2><p>项目上下文正在持续更新</p></div><button class="icon-button small" aria-label="更多"><AppIcon name="more" /></button></div>
        <div class="activity-list">
          <div v-for="item in ACTIVITY" :key="item.initials" class="activity-item">
            <span class="activity-avatar" :class="item.avatar">{{ item.initials }}</span>
            <div><p><strong>{{ item.who }}</strong> {{ item.what }}</p><small>{{ item.detail }}</small><time>{{ item.time }}</time></div>
          </div>
        </div>
        <button class="view-all-button">查看完整活动记录<AppIcon name="arrow-right" /></button>
      </section>
    </div>
  </div>
</template>
