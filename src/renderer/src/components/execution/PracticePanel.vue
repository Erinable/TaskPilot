<script setup lang="ts">
// Practice mode on the execution page: whether the reference solution is
// ready (its content stays locked until the first submission), Tutor's
// grading of the submission, and the reference beside the developer's diff.
// Agent text is rendered with {{ }} only.
import { computed, ref, watch } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import { describeErrorInfo } from '@/lib/errors.ts';
import { openWorkspaceFile } from '@/lib/open_file.ts';
import { diffLineKind } from '@/lib/review_model.ts';
import { splitPatch } from '@/lib/coding_patch.ts';
import { useExecutionStore } from '@/stores/execution.ts';
import { useNotesStore } from '@/stores/notes.ts';
import type * as ipc from '@shared/ipc_types.ts';

const props = defineProps<{ task: ipc.TaskView }>();

const execution = useExecutionStore();
const notes = useNotesStore();
// Comments already saved while this page is open, so the button says so.
const saved = ref(new Set<ipc.GradeComment>());

const save = async (comment: ipc.GradeComment) => {
  if (await notes.saveComment(props.task, comment)) saved.value = new Set([...saved.value, comment]);
};

type PracticeView = { text: string; tone: '' | 'success' | 'danger' };

const CATEGORY_LABELS: Record<ipc.GradeCategory, string> = { thinking: '思路', writing: '写法', style: '风格' };

const run = computed(() => props.task.referenceRun);
const grade = computed(() => props.task.grade);
// The patch is only handed over once QA has seen a submission.
const unlocked = computed(() => run.value?.status === 'ready' && props.task.review !== null);

const referenceText = computed((): PracticeView => {
  const reference = run.value;
  if (!reference) return { text: '这次没有参考答案。', tone: '' };
  if (reference.status === 'running') return { text: 'Coding Agent 正在后台写一份参考答案。你先自己写，交卷后才能看。', tone: '' };
  if (reference.status === 'failed')
    return { text: `参考答案没有写成：${describeErrorInfo(reference.error ?? { code: 'coding_failed', message: '' })}。判卷会只看你的代码。`, tone: 'danger' };
  if (reference.status === 'cancelled') return { text: '参考答案已取消。', tone: '' };
  return unlocked.value
    ? { text: `参考答案改了 ${reference.files.length} 个文件，可以和你的写法对照着看。`, tone: 'success' }
    : { text: '参考答案已经写好，交卷后解锁。', tone: 'success' };
});

const gradeText = computed((): string | null => {
  const current = grade.value;
  if (!current) return null;
  if (current.status === 'waiting') return 'QA 看完了，正在等参考答案写完再判卷。';
  if (current.status === 'running') return '导师正在判卷…';
  if (current.status === 'failed') return `判卷没有完成：${describeErrorInfo(current.error ?? { code: 'agent_failed', message: '' })}`;
  return current.withReference ? '导师对照参考答案判完了。' : '导师只根据你的代码判完了（没有参考答案）。';
});

const byCategory = computed(() => {
  const comments = grade.value?.report?.comments ?? [];
  return (Object.keys(CATEGORY_LABELS) as ipc.GradeCategory[])
    .map((category) => ({ category, label: CATEGORY_LABELS[category], comments: comments.filter((comment) => comment.category === category) }))
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
