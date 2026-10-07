<script setup lang="ts">
import { computed } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import * as activity from '@/lib/activity.ts';
import { businessDay } from '@/lib/time_zone.ts';
import { useAppStore } from '@/stores/app.ts';
import { useSettingsStore } from '@/stores/settings.ts';

const app = useAppStore();
const settings = useSettingsStore();

// Recent events reuse the overview the app already polls (newest 20).
const RECENT_PER_MEMBER = 3;

const costNote = computed(() => {
  const costs = app.activity?.costs;
  if (!costs?.since) return '还没有花费记录';
  if (!costs.partial) return '最近 7 天';
  const day = businessDay(new Date(costs.since));
  return `从 ${Number(day.slice(5, 7))} 月 ${Number(day.slice(8))} 日开始统计`;
});

const members = computed(() => {
  const overview = app.activity;
  const now = new Date();
  const feed = (overview?.recent ?? []).map(activity.toFeedItem);
  return activity.TEAM.map(({ agent, actor }) => {
    const presence = activity.presenceOf(overview?.team ?? null, agent);
    return {
      agent,
      actor,
      presence,
      label: activity.PRESENCE_LABELS[presence],
      role: activity.ROLES[agent],
      work: activity.workText(overview?.team ?? null, agent),
      cost: overview ? activity.formatCost(overview.costs.byAgent[agent]) : '–',
      recent: feed
        .filter((item) => item.actor === actor)
        .slice(0, RECENT_PER_MEMBER)
        .map((item) => ({
          ...item,
          text: item.detail ? `${item.what}：${item.detail}` : item.what,
          time: activity.relativeTime(item.at, now, overview?.timeZone ?? 'UTC'),
        })),
    };
  });
});
</script>

<template>
  <div class="view team-view">
    <div class="page-heading">
      <div>
        <h1>AI 团队</h1>
        <p>四位 AI 成员分工协作：问清需求、读代码、审查和准备发布。写代码的部分交给你。</p>
      </div>
      <span class="team-presence-chip">{{ activity.presenceSummary(app.activity?.team ?? null) }}</span>
    </div>

    <div class="team-grid">
      <section
        v-for="member in members"
        :id="`team-${member.agent}`"
        :key="member.agent"
        class="panel glass team-card"
        tabindex="-1"
        :aria-labelledby="`team-${member.agent}-name`"
      >
        <header class="team-card-head">
          <span class="agent-avatar large" :class="member.actor.avatar">{{ member.actor.initials }}</span>
          <div>
            <h2 :id="`team-${member.agent}-name`">{{ member.actor.name }}</h2>
            <span class="presence-text" :class="member.presence">
              <span class="presence" :class="member.presence" aria-hidden="true"></span>
              {{ member.label }}
            </span>
          </div>
        </header>

        <p class="team-role">{{ member.role }}</p>

        <dl class="team-facts">
          <div>
            <dt>现在</dt>
            <dd v-if="member.presence === 'offline'">
              暂时联系不上。确认 Claude Code CLI 已安装后再试。
              <button class="empty-action" type="button" @click="settings.open('environment').catch((caught) => console.error(caught))">检查运行环境</button>
            </dd>
            <dd v-else-if="member.work" class="team-work">{{ member.work }}</dd>
            <dd v-else class="muted">空闲，等待下一项任务</dd>
          </div>
          <div>
            <dt>本周花费</dt>
            <dd>
              <strong class="team-cost">{{ member.cost }}</strong>
              <small>{{ costNote }}</small>
            </dd>
          </div>
        </dl>

        <div class="team-recent">
          <h3>最近动态</h3>
          <ul v-if="member.recent.length">
            <li v-for="item in member.recent" :key="item.key">
              <span>{{ item.text }}</span>
              <time :datetime="item.at">{{ item.time }}</time>
            </li>
          </ul>
          <p v-else class="muted">最近没有动态。</p>
        </div>
      </section>
    </div>

    <button class="view-all-button team-all" type="button" @click="app.navigate('activity')">
      查看完整活动记录
      <AppIcon name="arrow-right" />
    </button>
  </div>
</template>

<style scoped>
.team-presence-chip {
  padding: var(--space-1) var(--space-3);
  color: var(--text-muted);
  background: var(--fill);
  border-radius: var(--radius-md);
  font-size: var(--text-sm);
}
.team-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  gap: var(--space-4);
}
.team-card {
  display: grid;
  align-content: start;
  gap: var(--space-4);
  padding: var(--panel-pad);
  outline: none;
}
/* Arriving from a sidebar member highlights that card. */
.team-card:focus {
  box-shadow: 0 0 0 2px var(--accent);
}
.team-card-head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}
.team-card-head h2 {
  margin: 0;
  color: var(--text);
  font-size: var(--text-lg);
  font-weight: 600;
}
.agent-avatar.large {
  width: 40px;
  height: 40px;
  flex-basis: 40px;
  font-size: var(--text-sm);
}
.presence-text {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: 2px;
  color: var(--text-tertiary);
  font-size: var(--text-xs);
}
.presence-text .presence {
  margin: 0;
}
.presence.busy {
  background: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.presence.offline {
  background: var(--text-tertiary);
  opacity: 0.6;
}
.team-role {
  margin: 0;
  color: var(--text-secondary);
  font-size: var(--text-md);
  line-height: 1.6;
}
.team-facts {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: var(--space-4);
  margin: 0;
  padding: var(--space-3) 0;
  border-block: 1px solid var(--line-soft);
}
.team-facts dt {
  margin-bottom: var(--space-1);
  color: var(--text-tertiary);
  font-size: var(--text-xs);
}
.team-facts dd {
  margin: 0;
  color: var(--text-secondary);
  font-size: var(--text-sm);
}
.team-facts .team-work {
  color: var(--accent-strong);
}
.team-cost {
  display: block;
  color: var(--text);
  font: 600 var(--text-lg) var(--font-mono);
}
.team-facts small {
  color: var(--text-tertiary);
  font-size: var(--text-xs);
}
.team-recent h3 {
  margin: 0 0 var(--space-2);
  color: var(--text-tertiary);
  font-size: var(--text-xs);
  font-weight: 500;
}
.team-recent ul {
  display: grid;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}
.team-recent li {
  display: flex;
  justify-content: space-between;
  gap: var(--space-3);
  color: var(--text-secondary);
  font-size: var(--text-sm);
}
.team-recent li span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.team-recent time {
  flex: none;
  color: var(--text-tertiary);
  font-size: var(--text-xs);
}
.muted {
  margin: 0;
  color: var(--text-tertiary);
  font-size: var(--text-sm);
}
.team-all {
  margin-top: var(--space-4);
}
</style>
