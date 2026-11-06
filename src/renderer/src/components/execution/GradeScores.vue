<script setup lang="ts">
// A grade's two scores with every line of their breakdown, so neither reads
// as a verdict on its own. Grades from before scores show nothing here.
import { computed } from 'vue';

import { independenceLines, qualityLines, rubricLevels } from '@/lib/grade_scores.ts';
import type * as packageTypes from '@shared/ipc/packages.ts';

const props = defineProps<{ scores: packageTypes.GradeScores; report: packageTypes.GradeReport; rubric: { id: string; label: string }[] }>();

const quality = computed(() => qualityLines(props.scores));
const levels = computed(() => rubricLevels(props.report, props.rubric));
const independence = computed(() => independenceLines(props.scores));
const STEPS = [1, 2, 3, 4];
</script>

<template>
  <div class="grade-scores" data-scores>
    <section class="grade-score" data-score="quality">
      <h3>
        <span>质量分</span>
        <span class="grade-score-value">
          {{ scores.quality }}
          <small>/100</small>
        </span>
      </h3>
      <dl>
        <template v-for="line in quality" :key="line.label">
          <dt>{{ line.label }}</dt>
          <dd>{{ line.value }}</dd>
        </template>
      </dl>
      <div v-if="levels.length" class="grade-levels">
        <h4>rubric 各项等级</h4>
        <dl>
          <template v-for="line in levels" :key="`level-${line.label}`">
            <dt>{{ line.label }}</dt>
            <dd>
              <span class="grade-level-bar" :aria-label="line.value" role="img">
                <span v-for="step in STEPS" :key="step" class="grade-level-step" :class="{ filled: step <= line.level }" />
              </span>
              <span class="grade-level-text">{{ line.value }}</span>
            </dd>
          </template>
        </dl>
      </div>
    </section>
    <section class="grade-score" data-score="independence">
      <h3>
        <span>独立完成度</span>
        <span class="grade-score-value">
          {{ scores.independence }}
          <small>/100</small>
        </span>
      </h3>
      <dl>
        <template v-for="line in independence" :key="line.label">
          <dt>{{ line.label }}</dt>
          <dd>{{ line.value }}</dd>
        </template>
      </dl>
      <p class="grade-score-note" data-independence-note>独立完成度只统计 TaskPilot 内的辅助（提示、参考答案、Tutor 给过的代码），在别处查到的不算。</p>
    </section>
  </div>
</template>

<style scoped>
.grade-scores {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: var(--space-3);
}
.grade-score {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
  background: var(--fill);
  border-radius: var(--radius-md);
}
.grade-score h3 {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin: 0;
  color: var(--text-secondary);
  font-size: var(--text-lg);
  font-weight: 600;
}
.grade-score-value {
  color: var(--text);
  font-size: 2em;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  line-height: 1;
}
.grade-score-value small {
  color: var(--text-tertiary);
  font-size: var(--text-lg);
  font-weight: 400;
}
.grade-score dl {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 6px var(--space-3);
  margin: 0;
  font-size: var(--text-lg);
}
.grade-score dt {
  color: var(--text-secondary);
}
.grade-score dd {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2);
  margin: 0;
  font-variant-numeric: tabular-nums;
}
.grade-levels {
  padding-top: var(--space-3);
  border-top: 1px solid var(--line-soft);
}
.grade-levels h4 {
  margin: 0 0 var(--space-2);
  color: var(--text-tertiary);
  font-size: var(--text-lg);
  font-weight: 500;
}
.grade-level-bar {
  display: inline-flex;
  gap: 3px;
}
.grade-level-step {
  width: 18px;
  height: 6px;
  background: var(--line-soft);
  border-radius: 3px;
}
.grade-level-step.filled {
  background: var(--accent);
}
.grade-level-text {
  min-width: 4.5em;
  color: var(--text-secondary);
  text-align: right;
}
.grade-score-note {
  margin: auto 0 0;
  color: var(--text-tertiary);
  font-size: var(--text-lg);
}
</style>
