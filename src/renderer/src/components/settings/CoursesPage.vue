<script setup lang="ts">
// The course pack the open repository teaches with: which one is in use and
// where the choice came from, picking another on this machine, previewing
// any pack, and importing a pack file into the global folder.
import { computed } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import { FROM_LABELS, SOURCE_LABELS, TRUST_LABELS, languageMismatch } from '@/lib/course_model.ts';
import { useCoursesStore } from '@/stores/courses.ts';
import CoursePreviewDialog from './CoursePreviewDialog.vue';
import type * as courseTypes from '@shared/ipc/courses.ts';

const courses = useCoursesStore();

const current = computed(() => courses.current);
const entries = computed(() => courses.list?.entries ?? []);
const languages = computed(() => courses.list?.languages ?? []);
const inUse = computed(() => entries.value.find((entry) => entry.id === current.value?.ref.id) ?? null);
const selectedEntry = computed(() => entries.value.find((entry) => entry.id === current.value?.selected.id) ?? null);
const mismatch = computed(() => languageMismatch(selectedEntry.value?.languages, languages.value));

const isSelected = (entry: courseTypes.CourseEntry) => current.value?.selected.id === entry.id;

const run = (promise: Promise<unknown>) => {
  promise.catch((error) => console.error(error));
};
</script>

<template>
  <header class="settings-page-header">
    <h2>课程包</h2>
    <span class="scope-badge">
      <AppIcon name="blocks" />
      本机选择 + 项目配置
    </span>
  </header>
  <p class="settings-page-intro">
    课程包决定 Product Lead 怎么规划、导师怎么讲解和按哪些维度判卷。先看本机的选择，再看仓库 taskpilot.toml 的
    course，都没设时用「编程」。切换只影响之后的规划和判卷，已有的计划和判卷记录不变。
  </p>

  <template v-if="current">
    <div id="courseState" class="settings-card glass project-file" :class="current.state.status">
      <AppIcon :name="current.state.status === 'ok' ? 'check-circle' : 'alert'" class="project-icon" />
      <div class="project-body">
        <strong>
          正在使用：{{ inUse?.title ?? current.ref.id }}
          <span class="scope-badge">{{ current.ref.id }} · {{ current.ref.version }}</span>
          <small>（{{ SOURCE_LABELS[current.ref.source] }}，选择来自{{ FROM_LABELS[current.selected.from] }}）</small>
        </strong>
        <p v-if="current.state.status === 'pending'" class="warn-text" role="status">
          课程包待确认：选中的「{{ current.state.pack.title }}」还没在本机确认，或者内容变了。确认前先用内置的「编程」课程包。
        </p>
        <p v-else-if="current.state.status === 'invalid'" role="alert">
          <code>{{ current.state.error.message }}</code>
          先用内置的「编程」课程包。
        </p>
        <p v-if="mismatch" id="courseLanguageWarning" class="warn-text" role="status">
          「{{ selectedEntry?.title ?? selectedEntry?.id }}」是为 {{ mismatch.join(', ') }} 写的，这个仓库的语言是
          {{ languages.join(', ') }}。仍然可以用，只是讲解和判卷可能不贴合。
        </p>
      </div>
      <button
        v-if="current.state.status === 'pending'"
        id="confirmCourse"
        class="primary-button small"
        type="button"
        @click="run(courses.openPreview(current.state.ref.id))"
      >
        <AppIcon name="check-circle" />
        查看并确认
      </button>
    </div>

    <h3 class="settings-section-title">
      可选的课程包
      <small>选中后写入本机设置；仓库和导入的包要先确认</small>
    </h3>
    <div id="courseList" class="settings-card glass">
      <div v-for="entry in entries" :key="entry.id" class="setting-row course-row" :data-course="entry.id">
        <div class="setting-label">
          <strong>
            {{ entry.title ?? entry.id }}
            <span class="scope-badge">{{ SOURCE_LABELS[entry.source] }}</span>
            <span class="scope-badge" :class="`trust-${entry.trust}`">{{ TRUST_LABELS[entry.trust] }}</span>
            <span v-if="isSelected(entry)" class="scope-badge selected">已选</span>
          </strong>
          <small v-if="entry.error" class="warn-text">{{ entry.error }}</small>
          <small v-else>
            {{ entry.id }} · {{ entry.version }}
            <template v-if="entry.languages">· 适用 {{ entry.languages.join(', ') }}</template>
            <template v-if="languageMismatch(entry.languages, languages)">（和仓库语言不匹配）</template>
          </small>
        </div>
        <div class="setting-control end">
          <button v-if="!entry.error" class="secondary-button small" type="button" data-action="preview" @click="run(courses.openPreview(entry.id))">
            <AppIcon name="file" />
            预览
          </button>
          <button
            v-if="!entry.error && !isSelected(entry)"
            class="secondary-button small"
            type="button"
            data-action="select"
            :disabled="courses.busy"
            @click="run(courses.select(entry.id))"
          >
            <AppIcon name="check" />
            选用
          </button>
        </div>
      </div>
      <div v-if="current.selected.from === 'local'" class="setting-row">
        <div class="setting-label">
          <strong>本机设置覆盖了仓库的选择</strong>
          <small>清除后按 taskpilot.toml 的 course 选，没设时用「编程」</small>
        </div>
        <div class="setting-control end">
          <button id="clearCourse" class="secondary-button small" type="button" :disabled="courses.busy" @click="run(courses.select(null))">
            <AppIcon name="undo" />
            清除本机选择
          </button>
        </div>
      </div>
    </div>

    <h3 class="settings-section-title">导入</h3>
    <div class="settings-card glass">
      <div class="setting-row stacked">
        <div class="path-header">
          <div class="setting-label">
            <strong>从文件导入课程包</strong>
            <small>校验通过、看过全部内容后，复制到本机的全局目录，所有仓库都能选。导入不等于确认，选用后还要确认。</small>
          </div>
          <button id="importCourse" class="secondary-button small" type="button" @click="run(courses.pickImport())">
            <AppIcon name="plus" />
            选择文件…
          </button>
        </div>
        <code id="courseUserDir" class="path-chip">{{ courses.list?.userDir }}</code>
      </div>
    </div>
  </template>
  <p v-else-if="courses.loading" class="settings-note">
    <AppIcon name="spinner" />
    <span>正在读取课程包…</span>
  </p>

  <CoursePreviewDialog />
</template>

<style scoped>
.project-file {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: 14px 16px;
  font-size: var(--text-sm);
}
.project-file.invalid,
.project-file.pending {
  border-color: var(--warning);
}
.project-icon {
  flex: none;
  width: 18px;
  height: 18px;
  margin-top: 1px;
  color: var(--text-muted);
}
.project-file.ok .project-icon {
  color: var(--success);
}
.project-file.invalid .project-icon,
.project-file.pending .project-icon {
  color: var(--warning);
}
.project-body {
  display: grid;
  flex: 1;
  gap: 6px;
  min-width: 0;
}
.project-body p {
  margin: 0;
  color: var(--text-secondary);
}
.project-body code {
  font-family: var(--font-mono);
  overflow-wrap: anywhere;
}
.course-row .setting-label strong {
  flex-wrap: wrap;
  gap: var(--space-1);
}
.scope-badge.trust-pending,
.scope-badge.trust-invalid {
  color: var(--warning);
}
.scope-badge.selected {
  font-weight: 600;
}
</style>
