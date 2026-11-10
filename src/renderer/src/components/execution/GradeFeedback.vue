<script setup lang="ts">
// Dimension levels and feedback share a row. The observation previews the
// comment; opening the row reveals its location, next step and save action.
import { computed } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import { gradeDimensions } from '@/lib/grade_scores.ts';
import { openWorkspaceFile } from '@/lib/open_file.ts';
import type * as packageTypes from '@shared/ipc/packages.ts';

const props = defineProps<{
  report: packageTypes.GradeReport;
  rubric: { id: string; label: string }[];
  saved: Set<packageTypes.GradeComment>;
}>();
const emit = defineEmits<{ save: [comment: packageTypes.GradeComment] }>();

const dimensions = computed(() => gradeDimensions(props.report, props.rubric));
const STEPS = [1, 2, 3, 4];
</script>

<template>
  <section v-if="dimensions.length" class="grade-feedback" aria-label="评分维度与点评" data-grade-feedback>
    <h3 class="grade-feedback-title">评分维度与点评</h3>
    <component
      :is="dimension.comments.length ? 'details' : 'section'"
      v-for="dimension in dimensions"
      :key="dimension.id"
      class="grade-dimension"
      :data-category="dimension.id"
    >
      <component :is="dimension.comments.length ? 'summary' : 'div'" class="grade-dimension-heading">
        <div class="grade-dimension-top">
          <h3>{{ dimension.label }}</h3>
          <span v-if="dimension.level !== null" class="grade-dimension-level" :aria-label="`${dimension.level}/4 级`" data-dimension-level>
            <span class="grade-level-bar" aria-hidden="true">
              <span v-for="step in STEPS" :key="step" :class="{ filled: step <= dimension.level }" />
            </span>
            <span>
              {{ dimension.level }}/4
              <small>级</small>
            </span>
          </span>
          <span v-if="dimension.comments.length" class="grade-comment-count">{{ dimension.comments.length }} 条点评</span>
          <AppIcon v-if="dimension.comments.length" name="chevron-right" class="grade-dimension-chevron" />
        </div>
        <p class="grade-dimension-preview">{{ dimension.comments[0]?.observation ?? '没有单独点评。' }}</p>
      </component>
      <div v-if="dimension.comments.length" class="grade-dimension-comments">
        <article v-for="(comment, index) in dimension.comments" :key="index" class="grade-comment">
          <div class="grade-comment-head">
            <button v-if="comment.file" class="grade-location" type="button" @click="openWorkspaceFile(comment.file, comment.line)">
              <AppIcon name="file" />
              {{ comment.line ? `${comment.file}:${comment.line}` : comment.file }}
            </button>
            <span v-else class="grade-overall" data-overall>整体</span>
            <span v-if="comment.repeated" class="grade-repeated" data-repeated>又出现了</span>
            <button class="link-button grade-save" type="button" data-action="save-note" :disabled="saved.has(comment)" @click="emit('save', comment)">
              <AppIcon :name="saved.has(comment) ? 'check' : 'plus'" />
              {{ saved.has(comment) ? '已存为笔记' : '存为笔记' }}
            </button>
          </div>
          <p>{{ comment.observation }}</p>
          <p class="grade-better">
            <strong>下次可以：</strong>
            {{ comment.betterWay }}
          </p>
        </article>
      </div>
    </component>
  </section>
</template>

<style scoped>
.grade-feedback {
  container-type: inline-size;
}
.grade-feedback-title {
  margin: 0 0 var(--space-2);
  font-size: var(--text-md);
}
.grade-dimension {
  min-width: 0;
  border-top: 1px solid var(--line-soft);
}
.grade-dimension-heading {
  display: block;
  padding: var(--space-3) var(--space-2);
  border-radius: var(--radius-sm);
}
summary.grade-dimension-heading {
  list-style: none;
  cursor: pointer;
  transition: background 0.15s var(--ease);
}
summary.grade-dimension-heading::-webkit-details-marker {
  display: none;
}
summary.grade-dimension-heading:hover,
.grade-dimension[open] > summary {
  background: var(--fill);
}
summary.grade-dimension-heading:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.grade-dimension-top {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
}
.grade-dimension-top h3 {
  flex: 1;
  min-width: 0;
  margin: 0;
  color: var(--text);
  font-size: var(--text-sm);
  font-weight: 600;
  overflow-wrap: anywhere;
}
.grade-dimension-level {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: var(--space-2);
  color: var(--accent);
  font-size: var(--text-sm);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.grade-dimension-level small {
  color: var(--text-tertiary);
  font-size: var(--text-xs);
}
.grade-level-bar {
  display: flex;
  gap: 3px;
}
.grade-level-bar span {
  width: 10px;
  height: 5px;
  border-radius: 2px;
  background: var(--line-soft);
}
.grade-level-bar .filled {
  background: var(--accent);
}
.grade-comment-count {
  flex: none;
  color: var(--text-muted);
  font-size: var(--text-xs);
}
.grade-dimension-chevron {
  flex: none;
  width: 12px;
  height: 12px;
  color: var(--text-tertiary);
  transition: transform 0.15s var(--ease);
}
.grade-dimension[open] .grade-dimension-chevron {
  transform: rotate(90deg);
}
.grade-dimension-preview {
  overflow: hidden;
  margin: var(--space-1) 0 0;
  color: var(--text-muted);
  font-size: var(--text-sm);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.grade-dimension[open] .grade-dimension-preview {
  display: none;
}
.grade-dimension-comments {
  padding: 0 var(--space-2) var(--space-3);
}
.grade-comment {
  display: grid;
  gap: var(--space-2);
  padding: var(--space-3) 0;
  font-size: var(--text-sm);
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.grade-comment + .grade-comment {
  border-top: 1px solid var(--line-soft);
}
.grade-comment p {
  margin: 0;
}
.grade-comment-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}
.grade-location {
  display: inline-flex;
  max-width: 100%;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-1) 0;
  border: 0;
  background: none;
  color: var(--accent);
  font: var(--text-xs) var(--font-mono);
  overflow-wrap: anywhere;
  text-align: left;
}
.grade-location:hover {
  color: var(--accent-strong);
  text-decoration: underline;
  text-underline-offset: 3px;
}
.grade-overall,
.grade-repeated {
  color: var(--text-secondary);
  font-size: var(--text-xs);
}
.grade-repeated {
  padding: 1px var(--space-1);
  border-radius: var(--radius-sm);
  background: var(--warning-soft);
  color: var(--warning);
}
.grade-save {
  flex: none;
  min-height: 28px;
  margin-left: auto;
  font-size: var(--text-xs);
}
.grade-save:disabled {
  color: var(--text-muted);
  cursor: default;
}
.grade-better {
  color: var(--text-secondary);
}
.grade-better strong {
  color: var(--success);
  font-weight: 500;
}
@container (max-width: 360px) {
  .grade-dimension-top {
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-2);
  }
  .grade-level-bar {
    display: none;
  }
  .grade-comment-count {
    display: none;
  }
}
@media (prefers-reduced-motion: reduce) {
  .grade-dimension-chevron,
  summary.grade-dimension-heading {
    transition: none;
  }
}
</style>
