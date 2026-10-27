<script setup lang="ts">
// Practice mode on the execution page: whether the reference solution is
// ready (its content stays locked until every test of the package passed or
// the hints were used up to L5), Tutor's grading of the submission with its
// two scores, explaining the differences from the reference, and the
// reference beside the developer's diff.
// Agent text is rendered with {{ }} only.
import { computed, onMounted, ref, watch } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import GradeExplanation from '@/components/execution/GradeExplanation.vue';
import GradeScores from '@/components/execution/GradeScores.vue';
import { describeErrorInfo } from '@/lib/errors.ts';
import { openWorkspaceFile } from '@/lib/open_file.ts';
import { diffLineKind } from '@/lib/review_model.ts';
import { splitPatch } from '@/lib/coding_patch.ts';
import { useExecutionStore } from '@/stores/execution.ts';
import { useCoursesStore } from '@/stores/courses.ts';
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
const byCategory = computed(() => {
  const comments = grade.value?.report?.comments ?? [];
  return rubric.value
    .map((item) => ({ category: item.id, label: item.label, comments: comments.filter((comment) => comment.category === item.id) }))
    .filter((group) => group.comments.length);
});

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

// Fetched once unlocked; a new reference run replaces the old patch.
watch(
  () => [unlocked.value, run.value?.id],
  () => {
    if (unlocked.value && execution.reference?.id !== run.value?.id) execution.loadReference().catch((error) => console.error(error));
  },
  { immediate: true },
);

// Read once at startup (App.vue); asked again here in case that failed.
onMounted(() => courses.loadDefault().catch((error) => console.error(error)));

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
        <p class="practice-summary">{{ grade.report.summary }}</p>
        <!-- Grades from before scores have none; nothing is shown for them. -->
        <GradeScores v-if="grade.scores" :scores="grade.scores" :report="grade.report" :rubric="rubric" />
        <div v-if="grade.report.strengths.length" class="practice-group">
          <h3>做得好的地方</h3>
          <ul>
            <li v-for="(strength, index) in grade.report.strengths" :key="index">{{ strength }}</li>
          </ul>
        </div>
        <div v-for="group in byCategory" :key="group.category" class="practice-group" :data-category="group.category">
          <h3>{{ group.label }}</h3>
          <article v-for="(comment, index) in group.comments" :key="index" class="practice-comment">
            <button v-if="comment.file" class="link-button practice-location" type="button" @click="openWorkspaceFile(comment.file, comment.line)">
              {{ comment.line ? `${comment.file}:${comment.line}` : comment.file }}
            </button>
            <p>
              <span v-if="comment.repeated" class="tag practice-repeated" data-repeated>又出现了</span>
              {{ comment.observation }}
            </p>
            <p class="practice-better">
              <strong>下次可以：</strong>
              {{ comment.betterWay }}
            </p>
            <button class="link-button practice-save" type="button" data-action="save-note" :disabled="saved.has(comment)" @click="save(comment)">
              <AppIcon :name="saved.has(comment) ? 'check' : 'plus'" />
              {{ saved.has(comment) ? '已存为笔记' : '存为笔记' }}
            </button>
          </article>
        </div>
        <GradeExplanation v-if="grade.withReference && unlocked" :explanation="grade.explanation ?? null" />
      </template>
    </div>

    <details v-if="unlocked" class="practice-reference" data-reference>
      <summary>参考写法</summary>
      <p v-if="execution.referenceError" class="practice-error">{{ execution.referenceError }}</p>
      <div v-for="file in referenceFiles" :key="file.path" class="diff-file">
        <div class="diff-file-header static">
          <span class="scope-path">{{ file.path }}</span>
        </div>
        <div class="diff-body">
          <div v-for="(line, index) in file.lines" :key="index" class="diff-line" :class="line.kind">{{ line.text }}</div>
        </div>
      </div>
    </details>
  </section>
</template>

<style scoped>
.practice-grade {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  margin-top: var(--space-3);
}
.practice-grade-status {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: 0;
  color: var(--text-secondary);
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
}
.practice-group h3 {
  margin: 0 0 var(--space-2);
  font-size: var(--text-sm);
}
.practice-group ul {
  margin: 0;
  padding-left: 1.2em;
}
.practice-comment {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: var(--space-2) 0;
  border-top: 1px solid var(--line-soft);
}
.practice-comment p {
  margin: 0;
}
.practice-location {
  align-self: flex-start;
  font-family: var(--font-mono);
  font-size: var(--text-sm);
}
.practice-better {
  color: var(--text-secondary);
}
.practice-repeated {
  margin-right: var(--space-1);
  color: var(--warning);
  background: var(--warning-soft);
}
.practice-save {
  align-self: flex-start;
  font-size: var(--text-sm);
}
.practice-reference {
  margin-top: var(--space-3);
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
