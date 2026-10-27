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
</script>

<template>
  <div class="grade-scores" data-scores>
    <section class="grade-score" data-score="quality">
      <h3>
        质量分
        <span class="grade-score-value">{{ scores.quality }}</span>
      </h3>
      <dl>
        <template v-for="line in quality" :key="line.label">
          <dt>{{ line.label }}</dt>
          <dd>{{ line.value }}</dd>
        </template>
        <template v-for="line in levels" :key="`level-${line.label}`">
          <dt class="grade-score-sub">{{ line.label }}</dt>
          <dd>{{ line.value }}</dd>
        </template>
      </dl>
    </section>
    <section class="grade-score" data-score="independence">
      <h3>
        独立完成度
        <span class="grade-score-value">{{ scores.independence }}</span>
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
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: var(--space-3);
}
.grade-score h3 {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin: 0 0 var(--space-2);
  font-size: var(--text-lg);
}
.grade-score-value {
  font-size: 1.5em;
  font-variant-numeric: tabular-nums;
}
.grade-score dl {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 2px var(--space-2);
  margin: 0;
  font-size: var(--text-lg);
}
.grade-score dt {
  color: var(--text-secondary);
}
.grade-score dd {
  margin: 0;
  font-variant-numeric: tabular-nums;
}
.grade-score-sub {
  padding-left: 1em;
}
.grade-score-note {
  margin: var(--space-2) 0 0;
  color: var(--text-secondary);
  font-size: var(--text-lg);
}
</style>
