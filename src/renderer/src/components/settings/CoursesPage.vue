<script setup lang="ts">
// The course pack settings: which pack the open repository uses and where
// the choice came from, the packs waiting for this machine's confirmation,
// and importing a pack file into the global folder. Browsing, copying and
// editing packs is the 课程 view.
//
// [人工决策-2026-10-27 00:55:52] 设置页只保留当前生效包的状态、信任确认和导入，浏览和编辑去「课程」视图。
import { computed } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import CoursePreviewDialog from '@/components/courses/CoursePreviewDialog.vue';
import { FROM_LABELS, SOURCE_LABELS, languageMismatch } from '@/lib/course_model.ts';
import { useAppStore } from '@/stores/app.ts';
import { useCoursesStore } from '@/stores/courses.ts';

const courses = useCoursesStore();
const app = useAppStore();

const current = computed(() => courses.current);
const entries = computed(() => courses.list?.entries ?? []);
const languages = computed(() => courses.list?.languages ?? []);
const inUse = computed(() => entries.value.find((entry) => entry.id === current.value?.ref.id) ?? null);
const selectedEntry = computed(() => entries.value.find((entry) => entry.id === current.value?.selected.id) ?? null);
const mismatch = computed(() => languageMismatch(selectedEntry.value?.languages, languages.value));

// Repository and imported packs not confirmed at their current content.
const pendingEntries = computed(() => entries.value.filter((entry) => entry.trust === 'pending'));
const isSelected = (id: string) => current.value?.selected.id === id;

const openCourses = () => run(app.navigate('courses'));

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

    <div v-if="current.selected.from === 'local'" class="settings-card glass">
      <div class="setting-row">
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

    <h3 class="settings-section-title">
      待确认的课程包
      <small>仓库和导入的包，内容第一次出现或变了以后，要在本机看过并确认</small>
    </h3>
    <div id="pendingCourses" class="settings-card glass">
      <div v-for="entry in pendingEntries" :key="entry.id" class="setting-row course-row" :data-course="entry.id">
        <div class="setting-label">
          <strong>
            {{ entry.title ?? entry.id }}
            <span class="scope-badge">{{ SOURCE_LABELS[entry.source] }}</span>
            <span v-if="isSelected(entry.id)" class="scope-badge selected">已选</span>
          </strong>
          <small>
            {{ entry.id }} · {{ entry.version }}
            <template v-if="languageMismatch(entry.languages, languages)">（和仓库语言不匹配）</template>
          </small>
        </div>
        <div class="setting-control end">
          <button class="secondary-button small" type="button" data-action="preview" @click="run(courses.openPreview(entry.id))">
            <AppIcon name="file" />
            预览
          </button>
          <button
            class="primary-button small"
            type="button"
            data-action="select"
            :disabled="courses.busy"
            @click="run(isSelected(entry.id) ? courses.openPreview(entry.id) : courses.select(entry.id))"
          >
            <AppIcon name="check-circle" />
            {{ isSelected(entry.id) ? '查看并确认' : '选用并确认' }}
          </button>
        </div>
      </div>
      <p v-if="pendingEntries.length === 0" class="setting-row settings-note" data-empty="pending">没有待确认的课程包。</p>
    </div>

    <div class="settings-card glass">
      <div class="setting-row">
        <div class="setting-label">
          <strong>浏览、复制和编辑课程包</strong>
          <small>所有课程包的完整内容在侧栏的「课程」里；内置包只读，可以复制一份再改</small>
        </div>
        <div class="setting-control end">
          <button id="openCourseView" class="secondary-button small" type="button" @click="openCourses">
            <AppIcon name="arrow-right" />
            去课程视图
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
.scope-badge.selected {
  font-weight: 600;
}
</style>
