<script setup lang="ts">
// Explaining the differences from the reference: Tutor picks up to three,
// the developer explains each or skips it, Tutor replies once, and the
// whole is saved as one note. It counts towards neither score.
// Agent text is rendered with {{ }} only.
import { computed, ref, watch } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import { describeErrorInfo } from '@/lib/errors.ts';
import { useExecutionStore } from '@/stores/execution.ts';
import type * as packageTypes from '@shared/ipc/packages.ts';

const props = defineProps<{ explanation: packageTypes.GradeExplanation | null }>();

const execution = useExecutionStore();
// The developer's drafts, one per difference.
const drafts = ref<string[]>([]);

watch(
  () => props.explanation?.items.length,
  () => {
    drafts.value = (props.explanation?.items ?? []).map((item) => item.answer ?? '');
  },
  { immediate: true },
);

const busy = computed(() => execution.explaining || props.explanation?.status === 'picking' || props.explanation?.status === 'reviewing');
const answering = computed(() => {
  const current = props.explanation;
  return current?.status === 'answering' || (current?.status === 'failed' && current.items.length > 0);
});

const statusText = computed((): string | null => {
  const current = props.explanation;
  if (!current) return null;
  if (current.status === 'picking') return '导师正在挑和参考实现的关键差异…';
  if (current.status === 'reviewing') return '导师正在看你的解释…';
  if (current.status === 'failed') return `没有完成：${describeErrorInfo(current.error ?? { code: 'agent_failed', message: '' })}`;
  if (current.status === 'done' && !current.items.length) return '你的写法和参考实现没有值得单独解释的差异。';
  return null;
});

const submit = () => execution.answerExplanation(drafts.value.map((draft) => draft.trim() || null));
</script>

<template>
  <div class="practice-group grade-explanation" data-explanation>
    <h3>解释和参考实现的差异</h3>
    <p class="grade-explanation-hint">不计入分数，只记录是否完成解释。</p>
    <button
      v-if="!explanation || (explanation.status === 'failed' && !explanation.items.length)"
      class="secondary-button small"
      type="button"
      data-action="explain"
      :disabled="busy"
      @click="execution.startExplanation()"
    >
      看看关键差异
    </button>
    <p v-if="statusText" class="grade-explanation-status">
      <AppIcon v-if="busy" name="spinner" class="spin" />
      {{ statusText }}
    </p>

    <article v-for="(item, index) in explanation?.items ?? []" :key="index" class="practice-comment" data-difference>
      <span v-if="item.file" class="practice-location">{{ item.file }}</span>
      <p>{{ item.difference }}</p>
      <label v-if="answering" class="grade-explanation-answer">
        <span>参考实现为什么这样做？（可以留空跳过）</span>
        <textarea v-model="drafts[index]" rows="3" maxlength="1000" :data-answer="index" />
      </label>
      <template v-else>
        <p class="practice-better">
          <strong>你的解释：</strong>
          {{ item.answer ?? '（跳过）' }}
        </p>
        <p v-if="item.feedback" class="practice-better" data-feedback>
          <strong>导师：</strong>
          {{ item.feedback.correct ? '对。' : `漏了：${item.feedback.missed ?? '一些要点'}` }}
        </p>
      </template>
    </article>

    <div class="practice-actions">
      <button v-if="answering" class="secondary-button small" type="button" data-action="answer" :disabled="busy" @click="submit">提交解释</button>
      <button
        v-if="explanation?.status === 'done' && explanation.items.length"
        class="secondary-button small"
        type="button"
        data-action="save-explanation"
        :disabled="busy || Boolean(explanation.noteId)"
        @click="execution.saveExplanation()"
      >
        <AppIcon :name="explanation.noteId ? 'check' : 'plus'" />
        {{ explanation.noteId ? '已存为笔记' : '存为笔记' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.grade-explanation-hint,
.grade-explanation-status {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: 0 0 var(--space-2);
  color: var(--text-secondary);
  font-size: var(--text-lg);
}
.grade-explanation-answer {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: var(--text-lg);
}
.grade-explanation-answer textarea {
  font: inherit;
  resize: vertical;
}
</style>
