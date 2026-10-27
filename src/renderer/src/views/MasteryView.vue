<script setup lang="ts">
// 掌握度: one course pack's concept graph coloured by how each concept
// stands (left), the notes due for review today and the most frequent error
// types (right). Picking a concept lists its attempts, the notes that carry
// it, and the labs and project tasks of the open repository that practise it.
//
// [人工决策-2026-10-27 00:36:21] 掌握度一期用简单记录加笔记的间隔复习，不做 BKT：页面只显示记录（次数、结果、独立完成度）和到期复习，
// 不显示概率或预测。
import { computed, onMounted, watch } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import NoteChart from '@/components/notes/NoteChart.vue';
import { RESULT_LABELS, STATE_LABELS, conceptGraph, conceptLinks } from '@/lib/mastery_model.ts';
import { formatTime } from '@/lib/release_model.ts';
import { useAppStore } from '@/stores/app.ts';
import { useCoursesStore } from '@/stores/courses.ts';
import { useExecutionStore } from '@/stores/execution.ts';
import { useMasteryStore } from '@/stores/mastery.ts';
import { useNotesStore } from '@/stores/notes.ts';
import { useTasksStore } from '@/stores/tasks.ts';
import { DEFAULT_COURSE_ID } from '@shared/course_pack.ts';
import type * as masteryTypes from '@shared/ipc/mastery.ts';

const mastery = useMasteryStore();
const courses = useCoursesStore();
const notes = useNotesStore();
const tasks = useTasksStore();
const app = useAppStore();
const execution = useExecutionStore();

const run = (promise: Promise<unknown>) => {
  promise.catch((error) => console.error(error));
};

const STATES = Object.keys(STATE_LABELS) as masteryTypes.ConceptState[];

const course = computed(() => mastery.course);
const concepts = computed(() => course.value?.concepts ?? []);
// Only packs that load; the page lists every one, the skeleton decides what shows.
const packs = computed(() => (courses.list?.entries ?? []).filter((entry) => entry.title !== null));
const pickedCourse = computed({
  get: () => course.value?.course.id ?? '',
  set: (id: string) => run(mastery.loadCourse(id)),
});
const graph = computed(() => conceptGraph(concepts.value, mastery.selected));
const selected = computed(() => concepts.value.find((concept) => concept.id === mastery.selected) ?? null);
const links = computed(() =>
  selected.value && course.value ? conceptLinks(selected.value.id, course.value.course.id, notes.notes, tasks.tasks, DEFAULT_COURSE_ID) : null,
);
const due = computed(() => mastery.reviews?.due ?? []);
const conceptLabel = (id: string) => concepts.value.find((concept) => concept.id === id)?.label ?? id;

const openNote = async (id: string) => {
  if (await app.navigate('notes')) run(notes.goNote(id));
};
const openTask = (id: string) => run(execution.open(id));

onMounted(() => {
  run(mastery.load());
  run(courses.load());
  run(notes.load());
});
// Picking another pack on the page clears the picked concept.
watch(
  () => course.value?.course.id,
  (next, previous) => {
    if (previous) mastery.select(null);
  },
);
</script>

<template>
  <div class="view mastery-view">
    <div class="page-heading">
      <div>
        <h1>掌握度</h1>
        <p>每个知识点做过几次、结果怎样，以及今天该复习的笔记。只统计 TaskPilot 里判过卷的练习。</p>
      </div>
      <div class="heading-actions">
        <el-select v-model="pickedCourse" class="mastery-course" aria-label="课程包" data-field="course">
          <el-option v-for="entry in packs" :key="entry.id" :label="entry.title ?? entry.id" :value="entry.id" />
        </el-select>
      </div>
    </div>

    <div v-if="course" class="mastery-columns">
      <section class="panel glass mastery-graph" data-section="graph" aria-label="知识点">
        <div class="panel-heading">
          <div>
            <h2>{{ course.course.title }}</h2>
            <p v-if="concepts.length">点一个知识点，看它的记录、笔记和练习。</p>
          </div>
        </div>
        <p v-if="!concepts.length" class="mastery-empty" data-empty="concepts">这个课程包没有知识点骨架。换一个有骨架的课程包，比如「操作系统」。</p>
        <template v-else>
          <ul class="mastery-legend" aria-label="图例">
            <li v-for="state in STATES" :key="state" :class="`legend-${state}`">{{ STATE_LABELS[state] }}</li>
          </ul>
          <NoteChart lang="mermaid" :source="graph" />
          <div class="mastery-concepts" role="list">
            <button
              v-for="concept in concepts"
              :key="concept.id"
              type="button"
              role="listitem"
              class="mastery-concept"
              :class="[concept.state, { active: concept.id === mastery.selected }]"
              :data-concept="concept.id"
              :data-state="concept.state"
              :aria-pressed="concept.id === mastery.selected"
              @click="mastery.select(concept.id === mastery.selected ? null : concept.id)"
            >
              {{ concept.label }}
              <small>{{ STATE_LABELS[concept.state] }}</small>
            </button>
          </div>
        </template>

        <section v-if="selected && links" class="mastery-detail" data-section="concept" aria-live="polite">
          <h3>{{ selected.label }}</h3>
          <p>{{ selected.summary }}</p>
          <p class="mastery-totals" data-field="totals">
            {{
              `${STATE_LABELS[selected.state]} · 共 ${selected.totals.attempts} 次：通过 ${selected.totals.pass}，部分通过 ${selected.totals.partial}，未通过 ${selected.totals.fail}`
            }}
          </p>
          <h4>做过的练习</h4>
          <ol v-if="selected.attempts.length" class="mastery-attempts" data-field="attempts">
            <li v-for="attempt in selected.attempts" :key="`${attempt.at}-${attempt.packageId}`">
              <time :datetime="attempt.at">{{ formatTime(attempt.at) }}</time>
              <span :class="`result-${attempt.result}`">{{ RESULT_LABELS[attempt.result] }}</span>
              <span>{{ attempt.independence === null ? '独立完成度 —' : `独立完成度 ${attempt.independence}` }}</span>
              <code>{{ attempt.packageId }}</code>
            </li>
          </ol>
          <p v-else class="mastery-empty">还没有判过卷的练习。</p>
          <h4>笔记</h4>
          <ul v-if="links.notes.length" class="mastery-links" data-field="notes">
            <li v-for="note in links.notes" :key="note.id">
              <button type="button" class="link-button" @click="openNote(note.id)">{{ note.title }}</button>
            </li>
          </ul>
          <p v-else class="mastery-empty">还没有带这个知识点的笔记。判卷后存下的点评和解释会带上它。</p>
          <h4>这个仓库里的 lab 和任务</h4>
          <ul v-if="links.labs.length || links.tasks.length" class="mastery-links" data-field="packages">
            <li v-for="task in [...links.labs, ...links.tasks]" :key="task.id">
              <button type="button" class="link-button" @click="openTask(task.id)">
                <AppIcon :name="task.lab ? 'flask' : 'box'" />
                {{ task.lab ? `第 ${task.lab.stage} 阶段 lab：${task.title}` : task.title }}
              </button>
              <small>{{ task.statusLabel }}</small>
            </li>
          </ul>
          <p v-else class="mastery-empty">打开的仓库里没有练这个知识点的 lab 或任务。</p>
        </section>
      </section>

      <aside class="mastery-side">
        <section class="panel glass" data-section="reviews" aria-label="今天复习">
          <div class="panel-heading">
            <div>
              <h2>今天复习</h2>
              <p v-if="mastery.reviews">{{ `${mastery.reviews.today} · 到期 ${due.length} 篇，共 ${mastery.reviews.total} 篇带知识点的笔记` }}</p>
            </div>
          </div>
          <ul v-if="due.length" class="mastery-reviews">
            <li v-for="item in due" :key="item.noteId" :data-review="item.noteId">
              <button type="button" class="link-button" @click="openNote(item.noteId)">{{ item.title }}</button>
              <small>{{ `第 ${item.box} 档 · ${item.concepts.map(conceptLabel).join('、')}` }}</small>
              <div class="mastery-review-actions">
                <button
                  class="secondary-button small"
                  type="button"
                  data-action="remembered"
                  :disabled="mastery.reviewing !== null"
                  @click="run(mastery.review(item.noteId, true))"
                >
                  <AppIcon name="check" />
                  记得
                </button>
                <button
                  class="secondary-button small"
                  type="button"
                  data-action="forgotten"
                  :disabled="mastery.reviewing !== null"
                  @click="run(mastery.review(item.noteId, false))"
                >
                  <AppIcon name="undo" />
                  不记得
                </button>
              </div>
            </li>
          </ul>
          <p v-else class="mastery-empty" data-empty="reviews">今天没有到期的笔记。</p>
        </section>
        <section class="panel glass" data-section="errors" aria-label="最近的错误类型">
          <div class="panel-heading">
            <div>
              <h2>常见错误 Top 5</h2>
              <p>这个课程包里各知识点判卷记下的错误类型。</p>
            </div>
          </div>
          <ol v-if="course.errorTypes.length" class="mastery-errors">
            <li v-for="entry in course.errorTypes" :key="entry.type" :data-error="entry.type">
              <code>{{ entry.type }}</code>
              <span>{{ `${entry.count} 次` }}</span>
            </li>
          </ol>
          <p v-else class="mastery-empty" data-empty="errors">还没有记下错误类型。</p>
        </section>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.mastery-view {
  font-size: var(--text-lg);
}
.mastery-course {
  width: 220px;
}
.mastery-columns {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(280px, 1fr);
  gap: var(--space-4);
  align-items: start;
}
.mastery-graph,
.mastery-side > section {
  padding-bottom: var(--panel-pad);
}
.mastery-side {
  display: grid;
  gap: var(--space-4);
}
.mastery-graph > :not(.panel-heading),
.mastery-side .panel-heading ~ * {
  margin-left: var(--panel-pad);
  margin-right: var(--panel-pad);
}
.mastery-legend {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  padding: 0;
  list-style: none;
}
.mastery-legend li::before {
  display: inline-block;
  width: 12px;
  height: 12px;
  margin-right: 6px;
  border: 1px solid;
  border-radius: 3px;
  content: '';
  vertical-align: -1px;
}
.legend-new::before {
  border-style: dashed !important;
  border-color: var(--text-tertiary);
}
.legend-learning::before {
  border-color: var(--warning);
  background: var(--warning-soft);
}
.legend-passed::before {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.legend-mastered::before {
  border-color: var(--success);
  background: var(--success-soft);
}
.mastery-concepts {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-top: var(--space-3);
}
.mastery-concept {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  padding: 4px 10px;
  border: 1px solid var(--glass-border);
  border-radius: 999px;
  background: var(--fill);
  color: var(--text);
  font: inherit;
  cursor: pointer;
}
.mastery-concept small {
  color: var(--text-secondary);
  font-size: var(--text-lg);
}
.mastery-concept.mastered {
  border-color: var(--success);
}
.mastery-concept.passed {
  border-color: var(--accent);
}
.mastery-concept.learning {
  border-color: var(--warning);
}
.mastery-concept.active {
  background: var(--accent-soft);
  font-weight: 600;
}
.mastery-detail {
  margin-top: var(--space-4);
  padding-top: var(--space-3);
  border-top: 1px solid var(--glass-border);
}
.mastery-detail h3 {
  margin: 0 0 var(--space-1);
  font-size: var(--text-xl);
}
.mastery-detail h4 {
  margin: var(--space-3) 0 var(--space-1);
  font-size: var(--text-lg);
}
.mastery-detail p {
  margin: 0 0 var(--space-1);
}
.mastery-attempts,
.mastery-links,
.mastery-reviews,
.mastery-errors {
  display: grid;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}
.mastery-attempts li {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  font-variant-numeric: tabular-nums;
}
.result-pass {
  color: var(--success);
}
.result-partial {
  color: var(--warning);
}
.result-fail {
  color: var(--danger);
}
.mastery-links li,
.mastery-reviews li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}
.mastery-reviews li {
  padding-bottom: var(--space-2);
  border-bottom: 1px solid var(--glass-border);
}
.mastery-review-actions {
  display: flex;
  gap: var(--space-2);
  margin-left: auto;
}
.mastery-errors li {
  display: flex;
  justify-content: space-between;
}
.link-button {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0;
  border: 0;
  background: none;
  color: var(--accent);
  font: inherit;
  cursor: pointer;
  text-align: left;
}
.mastery-view small {
  color: var(--text-secondary);
  font-size: var(--text-lg);
}
.mastery-empty,
.mastery-totals {
  color: var(--text-secondary);
}
@media (max-width: 900px) {
  .mastery-columns {
    grid-template-columns: 1fr;
  }
}
</style>
