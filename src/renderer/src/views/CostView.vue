<script setup lang="ts">
import { computed, onMounted } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import TeamTabs from '@/components/TeamTabs.vue';
import { useCostsStore } from '@/stores/costs.ts';
import * as view from '@/lib/cost_view.ts';
import type * as ipc from '@shared/ipc_types.ts';

const costs = useCostsStore();
const report = computed(() => costs.report);
const total = computed(() => (report.value ? view.spendText(report.value.total) : null));
const bars = computed(() => (report.value ? view.barHeights(report.value.byDay) : []));
const range = computed({ get: () => costs.days, set: (value: ipc.CostRange) => costs.setDays(value) });
const syncedAt = computed(() => (report.value?.prices ? report.value.prices.syncedAt.slice(0, 10) : null));

onMounted(() => costs.load().catch((error) => console.error(error)));
</script>

<template>
  <div class="view costs-view">
    <TeamTabs />
    <div class="page-heading">
      <div>
        <h1>成本</h1>
        <p>AI 团队每次调用模型的花费。只统计，不限制。</p>
      </div>
      <div class="heading-actions">
        <el-segmented v-model="range" :options="view.RANGE_OPTIONS" aria-label="统计天数" />
        <button class="icon-button" type="button" title="刷新" aria-label="刷新成本" :disabled="costs.loading" @click="costs.load()">
          <AppIcon :name="costs.loading ? 'spinner' : 'refresh'" :class="{ spin: costs.loading }" />
        </button>
      </div>
    </div>

    <p v-if="costs.error" class="empty-hint">
      <AppIcon name="alert" />
      读取成本失败：{{ costs.error }}
    </p>

    <template v-if="report && total">
      <section class="panel glass cost-summary" aria-label="总花费">
        <div>
          <span class="cost-label">最近 {{ report.days }} 天</span>
          <strong class="cost-total">{{ total.amount }}</strong>
          <span class="cost-detail">
            {{ report.total.calls }} 次调用
            <template v-if="total.detail">· {{ total.detail }}</template>
          </span>
        </div>
        <div class="cost-prices">
          <span v-if="syncedAt">价格表：models.dev，{{ syncedAt }} 同步</span>
          <span v-else>还没有同步价格，CLI 没报金额的调用只能记为未知。</span>
          <span v-if="report.total.unpricedCalls > 0">有 {{ report.total.unpricedCalls }} 次调用带 token 数但没有价格，同步后可能能估算。</span>
          <button class="secondary-button" type="button" :disabled="costs.syncing" @click="costs.syncPrices()">
            <AppIcon :name="costs.syncing ? 'spinner' : 'refresh'" :class="{ spin: costs.syncing }" />
            同步价格
          </button>
          <span v-if="costs.syncError" class="cost-error">同步失败：{{ costs.syncError }}</span>
        </div>
      </section>

      <section class="panel glass" aria-labelledby="costDaysTitle">
        <h2 id="costDaysTitle">每天</h2>
        <div class="cost-bars" role="list">
          <div v-for="(day, index) in report.byDay" :key="day.day" class="cost-bar" role="listitem" :title="`${day.day}：${view.spendText(day).amount}`">
            <span class="bar" :style="{ height: `${bars[index]}%` }"></span>
            <small>{{ day.day.slice(5) }}</small>
          </div>
        </div>
        <p v-if="report.rollupBefore" class="cost-hint">{{ report.rollupBefore }} 之前的数据来自按天汇总，不能按工作包查看。</p>
      </section>

      <div class="cost-grid">
        <section class="panel glass" aria-labelledby="costAgentsTitle">
          <h2 id="costAgentsTitle">按成员</h2>
          <table class="cost-table">
            <thead>
              <tr>
                <th>成员</th>
                <th>花费</th>
                <th>调用</th>
                <th>token</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in report.byAgent" :key="row.agent">
                <td>{{ view.agentName(row.agent) }}</td>
                <td>
                  {{ view.spendText(row).amount }}
                  <small>{{ view.spendText(row).detail }}</small>
                </td>
                <td>{{ row.calls }}</td>
                <td>{{ view.tokensText(row.tokens) }}</td>
              </tr>
            </tbody>
          </table>
          <p v-if="!report.byAgent.length" class="empty-hint">这段时间没有调用。</p>
        </section>

        <section class="panel glass" aria-labelledby="costModelsTitle">
          <h2 id="costModelsTitle">按模型</h2>
          <table class="cost-table">
            <thead>
              <tr>
                <th>CLI</th>
                <th>模型</th>
                <th>花费</th>
                <th>调用</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in report.byModel" :key="`${row.cli}/${row.provider}/${row.model}`">
                <td>{{ row.cli ?? '–' }}</td>
                <td>{{ view.modelName(row) }}</td>
                <td>
                  {{ view.spendText(row).amount }}
                  <small>{{ view.spendText(row).detail }}</small>
                </td>
                <td>{{ row.calls }}</td>
              </tr>
            </tbody>
          </table>
          <p v-if="!report.byModel.length" class="empty-hint">这段时间没有调用。</p>
        </section>
      </div>

      <section class="panel glass" aria-labelledby="costSubjectsTitle">
        <h2 id="costSubjectsTitle">按需求和工作包</h2>
        <table class="cost-table">
          <thead>
            <tr>
              <th>类型</th>
              <th>名称</th>
              <th>花费</th>
              <th>调用</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in report.bySubject" :key="`${row.kind}/${row.id}`">
              <td>{{ row.kind === 'package' ? '工作包' : '需求' }}</td>
              <td>{{ row.title }}</td>
              <td>
                {{ view.spendText(row).amount }}
                <small>{{ view.spendText(row).detail }}</small>
              </td>
              <td>{{ row.calls }}</td>
            </tr>
          </tbody>
        </table>
        <p v-if="!report.bySubject.length" class="empty-hint">这段时间没有关联到需求或工作包的调用。环境管家和发布的调用不属于任何工作包。</p>
      </section>
    </template>
  </div>
</template>

<style scoped>
.costs-view {
  display: grid;
  gap: var(--space-4);
}
.costs-view .panel {
  padding: var(--space-4) var(--panel-pad);
}
.costs-view h2 {
  margin: 0;
  color: var(--text);
  font-size: var(--text-lg);
  font-weight: 650;
}
.cost-summary {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-4);
  justify-content: space-between;
}
.cost-summary > div {
  display: grid;
  gap: var(--space-1);
}
.cost-label,
.cost-detail,
.cost-prices,
.cost-hint {
  color: var(--text-secondary);
  font-size: var(--text-sm);
}
.cost-total {
  font-size: var(--text-4xl);
}
.cost-prices {
  justify-items: start;
  max-width: 420px;
}
.cost-error {
  color: var(--danger);
}
.cost-bars {
  display: flex;
  gap: 4px;
  align-items: flex-end;
  height: 140px;
  margin-top: var(--space-3);
}
.cost-bar {
  flex: 1;
  min-width: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  align-items: center;
  gap: 4px;
}
.cost-bar .bar {
  width: 100%;
  max-width: 28px;
  border-radius: 4px 4px 0 0;
  background: var(--accent-gradient);
}
.cost-bar small {
  color: var(--text-tertiary);
  font-size: var(--text-xs);
  white-space: nowrap;
}
.costs-view:has(.cost-bar:nth-child(31)) .cost-bar small {
  display: none;
}
.cost-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
  gap: var(--space-4);
}
.cost-table {
  width: 100%;
  margin-top: var(--space-3);
  border-collapse: collapse;
  font-size: var(--text-sm);
}
.cost-table th {
  color: var(--text-secondary);
  font-weight: 500;
  text-align: left;
}
.cost-table th,
.cost-table td {
  padding: 6px 8px;
  border-bottom: 1px solid var(--line-soft);
  vertical-align: top;
}
.cost-table small {
  display: block;
  color: var(--text-tertiary);
}
</style>
