<script setup lang="ts">
import { computed, reactive } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import TeamTabs from '@/components/TeamTabs.vue';
import * as activity from '@/lib/activity.ts';
import { businessDay } from '@/lib/time_zone.ts';
import { useAppStore } from '@/stores/app.ts';
import { useSettingsStore } from '@/stores/settings.ts';
import { CLI_OPTIONS } from '@shared/agent_runtime.ts';
import type { AgentId } from '@shared/agent_runtime.ts';

const app = useAppStore();
const settings = useSettingsStore();

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
  const list = activity.TEAM.map(({ agent, actor }) => {
    const presence = activity.presenceOf(overview?.team ?? null, agent);
    return {
      agent,
      actor,
      presence,
      label: activity.PRESENCE_LABELS[presence],
      role: activity.ROLES[agent],
      runtime: settings.savedPreferences?.agents[agent],
      cli: CLI_OPTIONS.find((option) => option.id === settings.savedPreferences?.agents[agent]?.cli)?.label ?? '默认',
      work: activity.workText(overview?.team ?? null, agent),
      cost: overview ? activity.formatCost(overview.costs.byAgent[agent]) : '–',
      // Main picks each member's newest events from the whole retention
      // window; the shared feed is mostly the human's own steps.
      recent: (overview?.teamRecent[agent] ?? []).map(activity.toFeedItem).map((item) => ({
        ...item,
        text: item.detail ? `${item.what}：${item.detail}` : item.what,
        time: activity.relativeTime(item.at, now, overview?.timeZone ?? 'UTC'),
      })),
    };
  });
  return activity.sortByPresence(list);
});

// Working members always show the full card; the others open on request.
const expanded = reactive(new Set<AgentId>());
const rolesOpen = reactive(new Set<AgentId>());
const toggle = (set: Set<AgentId>, agent: AgentId) => (set.has(agent) ? set.delete(agent) : set.add(agent));
const openAgents = () => settings.open('agents').catch((caught) => console.error(caught));
</script>

<template>
  <div class="view team-view">
    <TeamTabs />
    <div class="page-heading">
      <div>
        <h1>AI 团队</h1>
        <p>AI 成员分工协作：拆需求、写代码、审查、发布、环境和辅导。正在工作的成员排在最前，其他成员点「展开」看详情。</p>
      </div>
      <span class="team-presence-chip">{{ activity.presenceSummary(app.activity?.team ?? null) }}</span>
    </div>

    <div class="team-grid">
      <section
        v-for="member in members"
        :id="`team-${member.agent}`"
        :key="member.agent"
        class="panel glass team-card"
        :class="{ compact: member.presence !== 'busy' && !expanded.has(member.agent) }"
        tabindex="-1"
        :aria-labelledby="`team-${member.agent}-name`"
      >
        <header class="team-card-head">
          <span class="agent-avatar large" :class="[member.actor.avatar, member.presence]">{{ member.actor.initials }}</span>
          <div class="team-card-title">
            <h2 :id="`team-${member.agent}-name`">{{ member.actor.name }}</h2>
            <span class="presence-text" :class="member.presence">
              <span class="presence" :class="member.presence" aria-hidden="true"></span>
              {{ member.label }}
            </span>
          </div>
          <button
            v-if="member.presence !== 'busy'"
            class="team-expand link-button"
            type="button"
            :aria-expanded="expanded.has(member.agent)"
            :aria-controls="`team-${member.agent}-details`"
            @click="toggle(expanded, member.agent)"
          >
            {{ expanded.has(member.agent) ? '收起' : '展开' }}
            <span class="visually-hidden">{{ member.actor.name }}</span>
          </button>
        </header>

        <div class="team-role-block">
          <button
            class="team-role-toggle link-button"
            type="button"
            :aria-expanded="rolesOpen.has(member.agent)"
            :aria-controls="`team-${member.agent}-role`"
            @click="toggle(rolesOpen, member.agent)"
          >
            这是做什么的
            <AppIcon name="chevron-down" class="team-role-chevron" :class="{ open: rolesOpen.has(member.agent) }" />
          </button>
          <p v-if="rolesOpen.has(member.agent)" :id="`team-${member.agent}-role`" class="team-role">{{ member.role }}</p>
        </div>

        <div v-if="member.presence !== 'busy' && !expanded.has(member.agent)" class="team-compact-line">
          <span v-if="member.recent.length" class="team-compact-recent">
            {{ member.recent[0].text }}
            <time :datetime="member.recent[0].at">{{ member.recent[0].time }}</time>
          </span>
          <span v-else class="muted">最近没有动态。</span>
          <button v-if="member.presence === 'offline'" class="empty-action" type="button" @click="openAgents">配置</button>
        </div>

        <div v-else :id="`team-${member.agent}-details`" class="team-details">
          <div class="team-runtime" aria-label="Agent 配置">
            <span>{{ member.cli }}</span>
            <span>{{ member.runtime?.model || 'CLI 默认模型' }}</span>
            <span>思考：{{ member.runtime?.thinking ?? '默认' }}</span>
            <button class="empty-action" type="button" @click="openAgents">配置</button>
          </div>

          <dl class="team-facts">
            <div>
              <dt>现在</dt>
              <dd v-if="member.presence === 'offline'">
                暂时联系不上。检查所选 CLI 的安装和运行环境。
                <button class="empty-action" type="button" @click="openAgents">配置 Agent</button>
              </dd>
              <dd v-else-if="member.work" class="team-work">{{ member.work }}</dd>
              <dd v-else class="muted">空闲，等待下一项任务</dd>
            </div>
            <div>
              <dt>本周花费</dt>
              <dd>
                <button
                  class="team-cost link-button"
                  type="button"
                  :aria-label="`${member.actor.name} 本周花费 ${member.cost}，查看成本页`"
                  @click="app.navigate('costs')"
                >
                  {{ member.cost }}
                </button>
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
.team-runtime {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  color: var(--text-muted);
  font-size: var(--text-xs);
}
.team-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  align-items: start;
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
.team-card-title {
  min-width: 0;
}
.team-expand {
  margin-left: auto;
  color: var(--accent-strong);
  font-size: var(--text-sm);
}
/* Idle and offline members fold to a single row of recent activity. */
.team-card.compact {
  gap: var(--space-3);
}
.team-card.compact .agent-avatar.offline {
  filter: grayscale(1);
  opacity: 0.5;
}
.team-compact-line {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
}
.team-compact-recent {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  color: var(--text-secondary);
  font-size: var(--text-sm);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.team-compact-recent time {
  margin-left: var(--space-2);
  color: var(--text-tertiary);
  font-size: var(--text-xs);
}
.team-compact-line .muted {
  flex: 1;
}
.team-details {
  display: grid;
  gap: var(--space-4);
}
.team-role-block {
  display: grid;
  gap: var(--space-2);
}
.team-role-toggle {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  justify-self: start;
  padding: 0;
  color: var(--text-tertiary);
  font-size: var(--text-sm);
}
.team-role-chevron {
  width: 14px;
  height: 14px;
  transition: transform 0.15s var(--ease);
}
.team-role-chevron.open {
  transform: rotate(180deg);
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
