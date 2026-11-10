<script setup lang="ts">
// Practice mode on the execution page: whether the reference solution is
// ready (its content stays locked until every test of the package passed or
// the hints were used up to L5), Tutor's grading of the submission with its
// two scores, explaining the differences from the reference, and the
// reference beside the developer's diff.
// Agent text is rendered with {{ }} only.
import { computed, onMounted, ref } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import GradeExplanation from '@/components/execution/GradeExplanation.vue';
import GradeFeedback from '@/components/execution/GradeFeedback.vue';
import GradeScores from '@/components/execution/GradeScores.vue';
import { describeErrorInfo } from '@/lib/errors.ts';
import { diffLineKind } from '@/lib/review_model.ts';
import { splitPatch } from '@/lib/coding_patch.ts';
import { useExecutionStore } from '@/stores/execution.ts';
import { useCoursesStore } from '@/stores/courses.ts';
import { useMasteryStore } from '@/stores/mastery.ts';
import { formatTime } from '@/lib/release_model.ts';
import { DEFAULT_COURSE_ID } from '@shared/course_pack.ts';
import { useNotesStore } from '@/stores/notes.ts';
import type * as packageTypes from '@shared/ipc/packages.ts';

const props = defineProps<{ task: packageTypes.TaskView }>();

const execution = useExecutionStore();
const notes = useNotesStore();
const courses = useCoursesStore();
// Comments already saved while this page is open, so the button says so.
const saved = ref(new Set<packageTypes.GradeComment>());

const save = async (comment: packageTypes.GradeComment) => {
  if (await notes.saveComment(props.task, comment)) saved.value = new Set([...saved.value, comment]);
};

type PracticeView = { text: string; tone: '' | 'success' | 'danger' };

const run = computed(() => props.task.referenceRun);
const grade = computed(() => props.task.grade);
// The main process decides; the patch is only handed over once unlocked.
const unlocked = computed(() => props.task.referenceLock?.unlocked === true);

// [人工决策-2026-10-27 00:51:12] 测试全过或提示用到 L5 才解锁；项目 practice 包也一样，不再是提交一次就能看。
const LOCKED_TEXT: Record<string, string> = {
  not_submitted: '参考答案已经写好。本包的测试全部通过，或者提示用到 L5 之后才能看。',
  tests_not_passed: '参考答案还锁着：上次提交还有测试没通过。测试全部通过，或者提示用到 L5 之后才能看。',
};

const referenceText = computed((): PracticeView => {
  const reference = run.value;
  if (!reference) return { text: '这次没有参考答案。', tone: '' };
  if (reference.status === 'running') return { text: 'Coding Agent 正在后台写一份参考答案。你先自己写，测试全部通过后才能看。', tone: '' };
  if (reference.status === 'failed')
    return { text: `参考答案没有写成：${describeErrorInfo(reference.error ?? { code: 'coding_failed', message: '' })}。判卷会只看你的代码。`, tone: 'danger' };
  if (reference.status === 'cancelled') return { text: '参考答案已取消。', tone: '' };
  return unlocked.value
    ? { text: `参考答案改了 ${reference.files.length} 个文件，可以和你的写法对照着看。`, tone: 'success' }
    : { text: LOCKED_TEXT[props.task.referenceLock?.reason ?? 'not_submitted'], tone: 'success' };
});

const gradeText = computed((): string | null => {
  const current = grade.value;
  if (!current) return null;
  if (current.status === 'waiting') return 'QA 看完了，正在等参考答案写完再判卷。';
  if (current.status === 'running') return '导师正在判卷…';
  if (current.status === 'failed') return `判卷没有完成：${describeErrorInfo(current.error ?? { code: 'agent_failed', message: '' })}`;
  return current.withReference ? '导师对照参考答案判完了。' : '导师只根据你的代码判完了（没有参考答案）。';
});

// [人工决策-2026-10-26 15:38:21] 维度和标签来自判卷时快照的 rubric；旧记录没有快照，按内置 programming 包显示。
// The default pack comes from the main process; until it answers an old grade lists nothing.
const rubric = computed(() => grade.value?.course?.rubric ?? courses.defaultPack?.rubric ?? []);

const referenceFiles = computed(() =>
  execution.reference && execution.reference.id === run.value?.id
    ? splitPatch(execution.reference.patch).map((segment) => ({
        path: segment.split('\n')[0].replace(/^diff --git a\/.* b\//, ''),
        lines: segment
          .split('\n')
          .filter((line) => line !== '')
          .map((line) => ({ kind: diffLineKind(line), text: line })),
      }))
    : [],
);

const referenceNotice = computed(() => {
  if (run.value?.revealedAt || execution.reference?.id === run.value?.id) return '已经查看过，再次打开不会重复扣分。';
  return props.task.referenceLock?.reason === 'hints_used'
    ? '测试还没有全部通过。现在展开查看参考写法，会使独立完成度扣 40 分；等测试全部通过后再看可避免这项扣分。'
    : '测试已经全部通过，现在展开查看参考写法不会扣除这项独立完成度分数。';
});

// Eligibility alone never reads the answer or records a scoring deduction.
const readReference = () => execution.loadReference().catch((error) => console.error(error));
const toggleReference = (event: Event) => {
  if ((event.currentTarget as HTMLDetailsElement).open) readReference();
};

// Read once at startup (App.vue); asked again here in case that failed.
onMounted(() => courses.loadDefault().catch((error) => console.error(error)));

// A done grade of a practised package with concepts is one attempt per
// concept in the mastery records (written by the main process).
const mastery = useMasteryStore();
const recorded = computed(() => (grade.value?.status === 'done' && props.task.mode === 'practice' ? (props.task.concepts ?? []) : []));
const openMastery = () =>
  mastery.openCourse(grade.value?.course?.id ?? props.task.course?.id ?? DEFAULT_COURSE_ID, recorded.value[0] ?? null).catch((error) => console.error(error));

const regrade = (skipReference: boolean) => execution.regrade(skipReference).catch((error) => console.error(error));
</script>

<template>
  <section class="panel glass practice-panel" aria-live="polite" data-practice>
    <div class="panel-heading">
      <div class="panel-title">
        <span class="panel-icon" :class="referenceText.tone">
          <AppIcon :name="run?.status === 'running' ? 'spinner' : 'flask'" :class="{ spin: run?.status === 'running' }" />
        </span>
        <div>
          <h2>练习</h2>
          <p data-reference-status>{{ referenceText.text }}</p>
        </div>
      </div>
    </div>

    <div v-if="grade" class="practice-grade" data-grade>
      <p class="practice-grade-status">
        <AppIcon v-if="grade.status === 'running'" name="spinner" class="spin" />
        {{ gradeText }}
        <time v-if="grade.status === 'done' && grade.finishedAt" :datetime="grade.finishedAt" data-field="graded-at">{{ formatTime(grade.finishedAt) }}</time>
      </p>
      <div class="practice-actions">
        <button v-if="grade.status === 'waiting'" class="secondary-button small" type="button" data-action="grade-now" @click="regrade(true)">
          不等了，直接判
        </button>
        <button v-if="grade.status === 'failed'" class="secondary-button small" type="button" data-action="regrade" @click="regrade(false)">
          <AppIcon name="refresh" />
          重新判卷
        </button>
      </div>

      <template v-if="grade.report">
        <!-- Grades from before scores have none; nothing is shown for them. -->
        <GradeScores v-if="grade.scores" :scores="grade.scores" />
        <p class="practice-summary">{{ grade.report.summary }}</p>
        <p v-if="recorded.length" class="practice-mastery" data-field="mastery">
          <span>这次判卷记进了掌握度：</span>
          <code v-for="conceptId in recorded" :key="conceptId" class="tag">{{ conceptId }}</code>
          <button class="link-button" type="button" data-action="open-mastery" @click="openMastery">
            <AppIcon name="target" />
            看掌握度
          </button>
        </p>
        <div v-if="grade.report.strengths.length" class="practice-group practice-strengths">
          <h3>
            <AppIcon name="check-circle" />
            做得好的地方
          </h3>
          <ul>
            <li v-for="(strength, index) in grade.report.strengths" :key="index">{{ strength }}</li>
          </ul>
        </div>
        <GradeFeedback :key="grade.id" :report="grade.report" :rubric="rubric" :saved="saved" @save="save" />
        <GradeExplanation v-if="grade.withReference && unlocked" :explanation="grade.explanation ?? null" />
      </template>
    </div>

    <div v-if="unlocked" class="practice-reference">
      <p class="practice-reference-notice" data-reference-notice>{{ referenceNotice }}</p>
      <details :key="`${task.id}:${run?.id}`" data-reference @toggle="toggleReference">
        <summary>查看参考写法</summary>
        <p v-if="execution.referenceLoading" role="status">正在读取参考写法…</p>
        <p v-if="execution.referenceError" class="practice-error">
          {{ execution.referenceError }}
          <button class="link-button" type="button" data-action="retry-reference" :disabled="execution.referenceLoading" @click="readReference">重试</button>
        </p>
        <div v-for="file in referenceFiles" :key="file.path" class="diff-file">
          <div class="diff-file-header static">
            <span class="scope-path">{{ file.path }}</span>
          </div>
          <div class="diff-body">
            <div v-for="(line, index) in file.lines" :key="index" class="diff-line" :class="line.kind">{{ line.text }}</div>
          </div>
        </div>
      </details>
    </div>
  </section>
</template>

<style scoped>
.practice-grade {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: 0 var(--panel-pad) var(--space-4);
}
.practice-grade-status {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: 0;
  color: var(--text-secondary);
}
.practice-grade-status time {
  margin-left: auto;
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
}
.practice-actions {
  display: flex;
  gap: var(--space-2);
}
.practice-actions:empty {
  display: none;
}
.practice-summary {
  margin: 0;
  padding: var(--space-3) var(--space-4);
  color: var(--text);
  background: var(--accent-soft);
  border-left: 1px solid var(--accent);
  border-radius: var(--radius-sm);
  font-size: var(--text-md);
  line-height: 1.6;
}
.practice-mastery {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  margin: 0;
  color: var(--text-secondary);
}
.practice-group {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.practice-group h3 {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: 0;
  font-size: var(--text-md);
}
.practice-strengths {
  padding: var(--space-3) var(--space-4);
  background: var(--success-soft);
  border-radius: var(--radius-md);
}
.practice-strengths h3 {
  color: var(--success);
}
.practice-group ul {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding-left: 1.2em;
  line-height: 1.6;
}
.practice-reference {
  margin: 0 var(--panel-pad) var(--space-4);
}
.practice-reference-notice {
  margin: 0 0 var(--space-2);
  color: var(--text-secondary);
  line-height: 1.6;
}
.practice-reference summary {
  cursor: pointer;
  font-weight: 600;
}
.practice-error {
  color: var(--danger);
}
.diff-file-header.static {
  cursor: default;
}
</style>
