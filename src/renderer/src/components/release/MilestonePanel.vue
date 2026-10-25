<script setup lang="ts">
import { computed, ref } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import { useReleaseStore } from '@/stores/release.ts';
import { useRequirementsStore } from '@/stores/requirements.ts';
import type { IconName } from '@/lib/icons.ts';
import type * as releaseTypes from '@shared/ipc/release.ts';

// Version plans at the top of the release page: what each version is meant
// to ship and how far it is. A complete plan leads straight into drafting
// the release notes below.
const emit = defineEmits<{ draft: [] }>();
const store = useReleaseStore();
const requirements = useRequirementsStore();

const milestones = computed(() => store.state?.milestones ?? []);
const open = computed(() => milestones.value.filter((milestone) => !milestone.releasedAt));
const released = computed(() => milestones.value.filter((milestone) => milestone.releasedAt).slice(0, 3));
// Requirements a plan can hold: published ones not already in another open plan.
const planned = computed(() => new Map(open.value.flatMap((milestone) => milestone.requirementIds.map((id) => [id, milestone.id] as const))));
const choices = (milestoneId: string | null) =>
  requirements.items
    .filter((item) => item.status === 'published' && (!planned.value.has(item.id) || planned.value.get(item.id) === milestoneId))
    .map((item) => ({ value: item.id, label: item.title || item.text.slice(0, 40) }));

// One form for create and edit; null when closed.
const form = ref<{ id: string | null; version: string; targetDate: string; requirementIds: string[] } | null>(null);
const startCreate = () => {
  form.value = { id: null, version: '', targetDate: '', requirementIds: [] };
};
const startEdit = (milestone: releaseTypes.MilestoneView) => {
  form.value = { id: milestone.id, version: milestone.version, targetDate: milestone.targetDate ?? '', requirementIds: [...milestone.requirementIds] };
};
const save = async () => {
  if (!form.value) return;
  const input = { version: form.value.version.trim(), targetDate: form.value.targetDate || null, requirementIds: form.value.requirementIds };
  const saved = form.value.id ? await store.updateMilestone(form.value.id, input) : await store.createMilestone(input);
  if (saved) form.value = null;
};

const percent = (milestone: releaseTypes.MilestoneView) => (milestone.total ? Math.round((milestone.done / milestone.total) * 100) : 0);
const requirementState = (item: releaseTypes.MilestoneView['requirements'][number]): { icon: IconName; text: string } =>
  item.total === 0
    ? { icon: 'circle', text: '还没有工作包' }
    : item.done === item.total
      ? { icon: 'check', text: '已完成' }
      : { icon: 'clock', text: `${item.done}/${item.total} 包` };
const dateText = (day: string | null) => (day ? `目标 ${day.slice(5).replace('-', '/')}` : '没有目标日期');
// Past its target date and not finished.
const late = (milestone: releaseTypes.MilestoneView) =>
  Boolean(milestone.targetDate && !milestone.complete && milestone.targetDate < new Date().toISOString().slice(0, 10));
</script>

<template>
  <section class="panel glass milestone-panel" aria-labelledby="milestonesTitle">
    <div class="panel-heading">
      <div class="panel-title">
        <span class="panel-icon"><AppIcon name="flag" /></span>
        <div>
          <h2 id="milestonesTitle">版本计划</h2>
          <p>先定好下个版本要放进哪些需求，做完后直接起草发布说明</p>
        </div>
      </div>
      <button v-if="!form" class="secondary-button" type="button" @click="startCreate">
        <AppIcon name="plus" />
        新建版本计划
      </button>
    </div>

    <form v-if="form" class="milestone-form" @submit.prevent="save">
      <label>
        <span>版本号</span>
        <el-input v-model="form.version" placeholder="例如 0.3.0" aria-label="版本号" maxlength="40" />
      </label>
      <label>
        <span>目标日期（可选）</span>
        <el-date-picker v-model="form.targetDate" type="date" value-format="YYYY-MM-DD" placeholder="不设日期" aria-label="目标日期" />
      </label>
      <label class="wide">
        <span>包含的需求</span>
        <el-select v-model="form.requirementIds" multiple filterable placeholder="选择已发布的需求" aria-label="包含的需求">
          <el-option v-for="option in choices(form.id)" :key="option.value" :label="option.label" :value="option.value" />
        </el-select>
        <small>一个需求只能放进一个版本；已在别的版本计划里的需求不会出现在这里。</small>
      </label>
      <p v-if="store.milestoneError" class="milestone-error" role="alert">
        <AppIcon name="alert" />
        {{ store.milestoneError }}
      </p>
      <div class="milestone-form-actions">
        <button class="secondary-button" type="button" @click="form = null">取消</button>
        <button class="primary-button" type="submit" :disabled="store.milestoneBusy || !form.version.trim()">
          <AppIcon v-if="store.milestoneBusy" name="spinner" class="spin" />
          {{ form.id ? '保存' : '创建' }}
        </button>
      </div>
    </form>

    <p v-if="!open.length && !form" class="empty-hint">
      <AppIcon name="flag" />
      还没有版本计划。新建一个，把接下来要做的需求放进去，就能看到这个版本还差多少。
    </p>

    <ul class="milestone-list">
      <li v-for="milestone in open" :key="milestone.id" class="milestone" :data-milestone="milestone.version">
        <div class="milestone-head">
          <strong class="milestone-version">{{ milestone.version }}</strong>
          <span class="milestone-date" :class="{ late: late(milestone) }">
            {{ late(milestone) ? `已过 ${dateText(milestone.targetDate)}` : dateText(milestone.targetDate) }}
          </span>
          <span class="milestone-count">{{ milestone.done }}/{{ milestone.total }} 个工作包</span>
          <span class="milestone-actions">
            <button class="icon-button small" type="button" :aria-label="`编辑 ${milestone.version}`" title="编辑" @click="startEdit(milestone)">
              <AppIcon name="sliders" />
            </button>
            <button class="icon-button small" type="button" :aria-label="`删除 ${milestone.version}`" title="删除" @click="store.deleteMilestone(milestone)">
              <AppIcon name="trash" />
            </button>
          </span>
        </div>
        <div
          class="milestone-bar"
          role="progressbar"
          :aria-valuenow="percent(milestone)"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-label="`${milestone.version} 完成 ${percent(milestone)}%`"
        >
          <span :style="{ width: `${percent(milestone)}%` }"></span>
        </div>
        <ul v-if="milestone.requirements.length" class="milestone-requirements">
          <li v-for="item in milestone.requirements" :key="item.id" :class="{ done: item.total > 0 && item.done === item.total }">
            <AppIcon :name="requirementState(item).icon" />
            <span>{{ item.title }}</span>
            <small>{{ requirementState(item).text }}</small>
          </li>
        </ul>
        <p v-else class="milestone-hint">还没有放进需求，点编辑添加。</p>
        <div v-if="milestone.complete" class="milestone-ready" role="status">
          <AppIcon name="check-circle" />
          <span>这个版本的工作包都完成了</span>
          <button class="primary-button small" type="button" @click="emit('draft')">起草发布说明</button>
        </div>
      </li>
    </ul>

    <p v-if="released.length" class="milestone-released">
      已发布：
      <span v-for="milestone in released" :key="milestone.id">{{ milestone.version }}</span>
    </p>
  </section>
</template>

<style scoped>
.milestone-panel {
  padding-bottom: var(--space-4);
}
.milestone-form {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-3);
  margin: 0 var(--panel-pad) var(--space-3);
  padding: var(--space-4);
  border-radius: var(--radius-md);
  background: var(--fill);
}
.milestone-form label {
  display: grid;
  gap: var(--space-1);
  color: var(--text-secondary);
  font-size: var(--text-sm);
}
.milestone-form .wide,
.milestone-error,
.milestone-form-actions {
  grid-column: 1 / -1;
}
.milestone-form small {
  color: var(--text-tertiary);
  font-size: var(--text-xs);
}
.milestone-form-actions {
  display: flex;
  gap: var(--space-2);
  justify-content: flex-end;
}
.milestone-error {
  display: flex;
  gap: var(--space-1);
  align-items: center;
  margin: 0;
  color: var(--danger);
  font-size: var(--text-sm);
}
.milestone-panel > .empty-hint {
  margin: 0 var(--panel-pad);
}
.milestone-list {
  display: grid;
  gap: var(--space-3);
  margin: 0;
  padding: 0 var(--panel-pad);
  list-style: none;
}
.milestone {
  display: grid;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-md);
}
.milestone-head {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  align-items: center;
  font-size: var(--text-sm);
}
.milestone-version {
  color: var(--text);
  font: 600 var(--text-lg) var(--font-mono);
}
.milestone-date,
.milestone-count {
  color: var(--text-tertiary);
}
.milestone-date.late {
  color: var(--warning);
}
.milestone-actions {
  display: flex;
  gap: var(--space-1);
  margin-left: auto;
}
.milestone-bar {
  height: 6px;
  overflow: hidden;
  border-radius: 3px;
  background: var(--fill);
}
.milestone-bar span {
  display: block;
  height: 100%;
  border-radius: 3px;
  background: var(--accent-gradient);
  transition: width 0.3s;
}
.milestone-requirements {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-4);
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: var(--text-sm);
}
.milestone-requirements li {
  display: inline-flex;
  gap: var(--space-1);
  align-items: center;
  color: var(--text-secondary);
}
.milestone-requirements li.done {
  color: var(--success);
}
.milestone-requirements .icon {
  width: 13px;
  height: 13px;
}
.milestone-requirements small {
  color: var(--text-tertiary);
}
.milestone-hint {
  margin: 0;
  color: var(--text-tertiary);
  font-size: var(--text-sm);
}
.milestone-ready {
  display: flex;
  gap: var(--space-2);
  align-items: center;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  color: var(--success);
  background: var(--success-soft);
  font-size: var(--text-sm);
}
.milestone-ready .icon {
  width: 15px;
  height: 15px;
}
.milestone-ready button {
  margin-left: auto;
}
.milestone-released {
  margin: var(--space-3) var(--panel-pad) 0;
  color: var(--text-tertiary);
  font-size: var(--text-xs);
}
.milestone-released span + span::before {
  content: ' · ';
}
</style>
