<script setup lang="ts">
// Scores and their evidence stay together in a compact overview. Dimension
// levels live with their comments in GradeFeedback, rather than being repeated.
import { computed } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import { independenceLines, qualityLines } from '@/lib/grade_scores.ts';
import type * as packageTypes from '@shared/ipc/packages.ts';

const props = defineProps<{ scores: packageTypes.GradeScores }>();

const quality = computed(() => qualityLines(props.scores));
const independence = computed(() => independenceLines(props.scores));
</script>

<template>
  <div class="grade-scores" data-scores>
    <div class="grade-score-columns">
      <section class="grade-score" data-score="quality">
        <h3>
          <span>质量分</span>
          <span class="grade-score-value">
            {{ scores.quality }}
            <small>/100</small>
          </span>
        </h3>
        <dl class="grade-breakdown">
          <div v-for="line in quality" :key="line.id" class="grade-score-line" :class="`score-source-${line.id}`">
            <dt>{{ line.label }}</dt>
            <dd>{{ line.value }}</dd>
            <dd class="grade-score-track" aria-hidden="true">
              <span :style="{ width: `${(line.points / line.maximum) * 100}%` }" />
            </dd>
          </div>
        </dl>
      </section>
      <section class="grade-score" data-score="independence">
        <h3>
          <span>独立完成度</span>
          <span class="grade-score-value">
            {{ scores.independence }}
            <small>/100</small>
          </span>
        </h3>
        <dl class="grade-deductions">
          <div v-for="line in independence" :key="line.label">
            <dt>
              <AppIcon v-if="line.value === '−0'" name="check-circle" class="grade-no-deduction" />
              {{ line.label }}
            </dt>
            <dd v-if="line.value !== '−0'">{{ line.value }}</dd>
          </div>
        </dl>
        <p class="grade-score-note" data-independence-note>独立完成度只统计 TaskPilot 内的辅助（提示、参考答案、Tutor 给过的代码），在别处查到的不算。</p>
      </section>
    </div>
  </div>
</template>

<style scoped>
.grade-scores {
  container-type: inline-size;
  padding: var(--space-4);
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-md);
  background: var(--fill);
}
.grade-score-columns {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: var(--space-5);
  align-items: start;
}
.grade-score {
  display: grid;
  align-content: start;
  gap: var(--space-3);
  min-width: 0;
}
.grade-score h3 {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  margin: 0;
  color: var(--text-secondary);
  font-size: var(--text-md);
  font-weight: 600;
}
.grade-score-value {
  display: inline-flex;
  align-items: baseline;
  gap: var(--space-1);
  color: var(--accent);
  font-size: var(--text-4xl);
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  line-height: 1.2;
}
[data-score='independence'] .grade-score-value {
  color: var(--success);
}
.grade-score-value small {
  color: var(--text-tertiary);
  font-size: var(--text-xs);
  font-weight: 400;
}
.grade-breakdown,
.grade-deductions {
  display: grid;
  gap: var(--space-2);
  margin: 0;
  font-size: var(--text-sm);
}
.grade-score-line {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: var(--space-1) var(--space-2);
}
.grade-score dt {
  color: var(--text-secondary);
}
.grade-score dd {
  margin: 0;
  color: var(--text);
  text-align: right;
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}
.grade-score-track {
  grid-column: 1 / -1;
  height: 3px;
  overflow: hidden;
  border-radius: 2px;
  background: var(--line-soft);
}
.grade-score-track span {
  display: block;
  height: 100%;
  background: var(--accent);
}
.score-source-qa .grade-score-track span {
  background: var(--hue-teal);
}
.score-source-rubric .grade-score-track span {
  background: var(--hue-violet);
}
.grade-deductions > div {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-3);
}
.grade-deductions dt {
  min-width: 0;
  overflow-wrap: anywhere;
}
.grade-deductions dd {
  flex: none;
  color: var(--warning);
}
.grade-no-deduction {
  margin-right: var(--space-1);
  color: var(--success);
}
.grade-score-note {
  margin: 0;
  color: var(--text-muted);
  font-size: var(--text-xs);
  line-height: 1.6;
}
@container (max-width: 440px) {
  .grade-score-columns {
    grid-template-columns: minmax(0, 1fr);
    gap: var(--space-4);
  }
  .grade-score + .grade-score {
    padding-top: var(--space-3);
    border-top: 1px solid var(--line-soft);
  }
}
</style>
