<script setup lang="ts">
// 课程: every course pack this repository can use (built in, the
// repository's, imported or copied), which one is in use, and a learner
// overview with the full instructions on demand. Any pack can be
// copied into the global folder to edit; imported and copied packs open in
// the form editor. Built-in packs are read-only.
//
// [人工决策-2026-10-27 00:55:52] 侧栏新增「课程」一级视图，浏览、复制再改和表单编辑都在这里；
// 内置包只读，只显示「复制再改」。保存后 contentHash 变了，要重新确认，界面要讲清楚。
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import CourseContent from '@/components/courses/CourseContent.vue';
import CourseEditor from '@/components/courses/CourseEditor.vue';
import CourseOverview from '@/components/courses/CourseOverview.vue';
import CoursePreviewDialog from '@/components/courses/CoursePreviewDialog.vue';
import { SOURCE_LABELS, TRUST_LABELS, changeText, copyIdFor, languageMismatch, sourcePath } from '@/lib/course_model.ts';
import { STATE_LABELS, stateCounts } from '@/lib/mastery_model.ts';
import { useCoursesStore } from '@/stores/courses.ts';
import { useMasteryStore } from '@/stores/mastery.ts';
import { useRepositoriesStore } from '@/stores/repositories.ts';
import { useRequirementsStore } from '@/stores/requirements.ts';
import { useSettingsStore } from '@/stores/settings.ts';
import { DEFAULT_COURSE_ID, isCourseId } from '@shared/course_pack.ts';
import type * as courseTypes from '@shared/ipc/courses.ts';

const courses = useCoursesStore();
const repositories = useRepositoriesStore();
const hasRepository = computed(() => repositories.currentId !== null);

const run = (promise: Promise<unknown>) => {
  promise.catch((error) => console.error(error));
};

const current = computed(() => courses.current);
const entries = computed(() => courses.list?.entries ?? []);
const languages = computed(() => (hasRepository.value ? (courses.list?.languages ?? []) : []));
const viewed = computed(() => courses.viewed);
const viewedEntry = computed(() => entries.value.find((entry) => entry.id === viewed.value?.ref.id) ?? null);
const location = computed(() => (viewed.value ? sourcePath(viewed.value.ref.id, viewed.value.ref.source, courses.list?.userDir ?? 'courses') : null));

const inUse = (entry: courseTypes.CourseEntry) => hasRepository.value && current.value?.ref.id === entry.id;
const isSelected = (entry: courseTypes.CourseEntry) => hasRepository.value && current.value?.selected.id === entry.id;
const isDefault = (entry: courseTypes.CourseEntry) => !hasRepository.value && entry.source === 'builtin' && entry.id === DEFAULT_COURSE_ID;
// The pack picked here that waits for this machine's confirmation.
const pendingHere = computed(() => {
  const state = hasRepository.value ? current.value?.state : null;
  return state?.status === 'pending' && state.ref.id === viewed.value?.ref.id ? state : null;
});
const editable = computed(() => viewed.value?.ref.source === 'user');

const GROUPS: { source: courseTypes.CourseEntry['source']; label: string }[] = [
  { source: 'builtin', label: '内置' },
  { source: 'repository', label: '仓库' },
  { source: 'user', label: '导入与自建' },
];
const groups = computed(() =>
  GROUPS.map((group) => ({ ...group, entries: entries.value.filter((entry) => entry.source === group.source) })).filter((group) => group.entries.length),
);

const editing = ref(false);
watch(
  () => viewed.value?.ref.id,
  (id) => {
    editing.value = Boolean(id && viewed.value?.ref.source === 'user' && courses.drafts[`user:${id}`]);
  },
  { immediate: true },
);
const open = (id: string) => {
  copying.value = false;
  run(courses.view(id));
};

// ========== Copy ==========
const copying = ref(false);
const copyId = ref('');
const copyError = ref<string | null>(null);
const takenIds = computed(() => entries.value.map((entry) => entry.id));

const startCopy = () => {
  if (!viewed.value) return;
  copyId.value = copyIdFor(viewed.value.ref.id, takenIds.value);
  copyError.value = null;
  copying.value = true;
};

const copyIdProblem = (id: string) => {
  if (!isCourseId(id)) return '只能用小写字母、数字、- 和 _，以字母开头，最长 32 个字符。';
  return takenIds.value.includes(id) ? '已经有这个 id 的课程包了。' : null;
};

const submitCopy = async () => {
  if (!viewed.value) return;
  copyError.value = copyIdProblem(copyId.value);
  if (copyError.value) return;
  const refused = await courses.copy(viewed.value.ref.id, copyId.value);
  if (refused) copyError.value = refused.message;
  else {
    copying.value = false;
    editing.value = true;
  }
};

// ========== Labs and mastery ==========
// The pack's lab repositories and how its concepts stand (mastery is global).
const mastery = useMasteryStore();
const summary = computed(() => (mastery.summary && mastery.summary.course.id === viewed.value?.ref.id ? mastery.summary : null));
const counts = computed(() => (summary.value ? stateCounts(summary.value.concepts) : null));
const MASTERY_STATES = Object.keys(STATE_LABELS) as (keyof typeof STATE_LABELS)[];
watch(
  () => viewed.value?.ref.id,
  (id) => {
    if (id) run(mastery.loadSummary(id));
  },
  { immediate: true },
);

const openSettings = () => run(useSettingsStore().open('courses'));
const learn = () => run(useRequirementsStore().open({ compose: 'course' }));

onMounted(() => {
  run(courses.enter(true));
  run(courses.loadView());
});
onBeforeUnmount(() => courses.leave());
</script>

<template>
  <div class="view course-view">
    <div class="page-heading">
      <div>
        <h1>课程</h1>
        <p>课程包决定 Product Lead 怎么规划、导师怎么讲解和按哪些维度判卷。内置包只读，想改就复制一份。</p>
      </div>
      <div class="heading-actions">
        <button class="primary-button" type="button" data-action="learn" @click="learn">
          <AppIcon name="flask" />
          我想学…
        </button>
        <button class="secondary-button" type="button" data-action="settings" @click="openSettings">
          <AppIcon name="settings" />
          确认与导入
        </button>
      </div>
    </div>

    <div v-if="courses.loadError" class="course-state" role="alert" data-error="courses-load">
      <AppIcon name="alert" />
      <span>
        读取课程包失败：{{ courses.loadError }}
        <template v-if="courses.list">。保留上次读取的内容。</template>
      </span>
      <button class="secondary-button small" type="button" data-action="retry-courses" :disabled="courses.loading" @click="run(courses.loadView())">
        重试
      </button>
    </div>
    <div v-if="courses.viewError" class="course-state" role="alert" data-error="course-preview">
      <AppIcon name="alert" />
      <span>读取「{{ courses.viewedId }}」失败：{{ courses.viewError }}。已显示的内容和草稿仍保留。</span>
      <button class="secondary-button small" type="button" data-action="retry-preview" @click="courses.viewedId && run(courses.view(courses.viewedId))">
        重试
      </button>
    </div>
    <div v-if="courses.list" class="course-columns">
      <nav class="panel glass course-list-panel" aria-label="课程包">
        <section v-for="group in groups" :key="group.source" class="course-group" :data-group="group.source">
          <h2>{{ group.label }}</h2>
          <button
            v-for="entry in group.entries"
            :key="entry.id"
            class="course-item"
            :class="{ active: viewed?.ref.id === entry.id }"
            type="button"
            :data-course="entry.id"
            :aria-current="viewed?.ref.id === entry.id ? 'true' : undefined"
            @click="open(entry.id)"
          >
            <span class="course-item-title">
              <strong>{{ entry.title ?? entry.id }}</strong>
              <span v-if="entry.source === 'user' && courses.drafts[`user:${entry.id}`]" class="scope-badge selected">编辑草稿</span>
              <span v-if="isDefault(entry)" class="scope-badge">默认课程</span>
              <span v-else-if="inUse(entry)" class="scope-badge in-use">正在使用</span>
              <span v-else-if="isSelected(entry)" class="scope-badge selected">已选，待确认</span>
            </span>
            <small v-if="entry.error" class="warn-text">{{ entry.error }}</small>
            <small v-else>
              {{ entry.id }} · {{ entry.version }}
              <span v-if="entry.trust === 'pending' || entry.trust === 'confirmed'" :class="`trust-${entry.trust}`">· {{ TRUST_LABELS[entry.trust] }}</span>
              <template v-if="languageMismatch(entry.languages, languages)">· 和仓库语言不匹配</template>
            </small>
          </button>
        </section>
      </nav>

      <section v-if="viewed" class="panel glass course-detail-panel" :data-detail="viewed.ref.id">
        <div class="panel-heading">
          <div>
            <h2>{{ viewed.pack.title }}</h2>
            <p>
              {{ viewed.pack.id }} · 版本 {{ viewed.pack.version }} · {{ SOURCE_LABELS[viewed.ref.source] }}
              <template v-if="location">
                ·
                <code>{{ location }}</code>
              </template>
            </p>
          </div>
          <div v-if="!editing" class="course-detail-actions">
            <button
              v-if="hasRepository && current && current.selected.id !== viewed.ref.id"
              class="primary-button small"
              type="button"
              data-action="select"
              :disabled="courses.busy"
              @click="run(courses.select(viewed.ref.id))"
            >
              <AppIcon name="check" />
              在这个仓库使用
            </button>
            <button v-if="editable" class="secondary-button small" type="button" data-action="edit" @click="editing = true">
              <AppIcon name="sliders" />
              编辑
            </button>
            <button class="secondary-button small" type="button" data-action="copy" @click="startCopy">
              <AppIcon name="copy" />
              复制再改
            </button>
          </div>
        </div>

        <div class="course-detail-body">
          <p v-if="!hasRepository" class="course-state" role="status" data-state="no-repository">
            <AppIcon name="info" />
            <span v-if="viewed.ref.id === DEFAULT_COURSE_ID">未打开仓库。这是内置默认课程；打开仓库后，课程选择会按仓库配置生效。</span>
            <span v-else>未打开仓库。可先浏览或复制课程包，打开仓库后再选择使用。</span>
          </p>
          <p v-else-if="pendingHere" class="course-state pending" role="status" data-state="pending">
            <AppIcon name="alert" />
            <span>这个仓库选了它，但内容还没在本机确认（或者保存后变了），规划和判卷暂时用内置的「编程」。</span>
            <button class="primary-button small" type="button" data-action="confirm" @click="run(courses.openPreview(viewed.ref.id))">查看并确认</button>
          </p>
          <p v-else-if="viewedEntry && inUse(viewedEntry)" class="course-state ok" role="status" data-state="in-use">
            <AppIcon name="check-circle" />
            <span>这个仓库正在用它规划和判卷。</span>
          </p>
          <p v-else-if="viewed.trust === 'pending'" class="course-state" role="status" data-state="unconfirmed">
            <AppIcon name="info" />
            <span>还没在本机确认过当前内容。选用后要先确认才会生效。</span>
          </p>
          <p v-if="viewedEntry && languageMismatch(viewedEntry.languages, languages)" class="course-state" role="status">
            <AppIcon name="info" />
            <span>
              它是为 {{ viewedEntry.languages?.join(', ') }} 写的，这个仓库的语言是 {{ languages.join(', ') }}。仍然可以用，只是讲解和判卷可能不贴合。
            </span>
          </p>

          <form v-if="copying" class="course-copy" novalidate aria-label="复制课程包" @submit.prevent="run(submitCopy())">
            <label for="courseCopyId">新课程包的 id</label>
            <input
              id="courseCopyId"
              v-model="copyId"
              class="field-input mono"
              type="text"
              :aria-invalid="Boolean(copyError)"
              aria-describedby="courseCopyHint"
              @input="copyError = null"
            />
            <small id="courseCopyHint" :class="{ 'course-field-error': copyError }" :role="copyError ? 'alert' : undefined">
              {{ copyError ?? `复制到 ${courses.list.userDir}，所有仓库都能选。复制品要在本机确认后才会用。` }}
            </small>
            <div class="course-copy-actions">
              <button class="secondary-button small" type="button" @click="copying = false">取消</button>
              <button class="primary-button small" type="submit" data-action="copy-submit" :disabled="courses.busy">
                <AppIcon name="copy" />
                复制并编辑
              </button>
            </div>
          </form>

          <section v-if="!editing && viewed.changes.length" class="course-changes" aria-label="改动">
            <strong>和本机上次确认的内容相比，改了 {{ viewed.changes.length }} 处：</strong>
            <ul>
              <li v-for="change in viewed.changes" :key="change.field">{{ changeText(change) }}</li>
            </ul>
          </section>

          <section v-if="summary && !editing" class="course-mastery" data-section="course-mastery" aria-label="实验仓库和掌握情况">
            <h3>实验仓库</h3>
            <ul v-if="summary.repositories.length" class="course-mastery-repos">
              <li v-for="repository in summary.repositories" :key="repository.id" :data-repository="repository.id">
                <strong>{{ repository.name }}</strong>
                <small>{{ `${repository.labs} 个 lab` }}</small>
                <span v-if="repository.current" class="scope-badge in-use">已打开</span>
                <button v-else class="secondary-button small" type="button" data-action="open-repository" @click="run(repositories.switchTo(repository.id))">
                  切换过去
                </button>
              </li>
            </ul>
            <p v-else class="course-mastery-empty">还没有用它建的实验仓库。点「我想学…」走一遍访谈，第一个 lab 生成后就能建。</p>
            <template v-if="counts && summary.concepts.length">
              <h3>掌握情况</h3>
              <p class="course-mastery-counts" data-field="mastery-counts">
                {{ `${summary.concepts.length} 个知识点：` }}
                <span v-for="state in MASTERY_STATES" :key="state" :class="`count-${state}`">{{ `${STATE_LABELS[state]} ${counts[state]}` }}</span>
              </p>
              <button class="secondary-button small" type="button" data-action="open-mastery" @click="run(mastery.openCourse(summary.course.id))">
                <AppIcon name="target" />
                看掌握度
              </button>
            </template>
          </section>

          <CourseEditor v-if="editing && editable" :key="viewed.ref.id" :pack="viewed.pack" @close="editing = false" />
          <template v-else>
            <CourseOverview :pack="viewed.pack" :source="viewed.ref.source" />
            <details :key="viewed.ref.id" class="course-instructions" data-section="course-instructions">
              <summary>完整课程指令</summary>
              <p>查看交给 Product Lead 和导师的全部课程包原文，包括讲解、难度、练习方式和参考答案指引。</p>
              <CourseContent :pack="viewed.pack" :changes="viewed.changes" />
            </details>
          </template>
        </div>
      </section>
    </div>

    <p v-else-if="courses.loading || !courses.loadError" class="empty-hint" data-loading>
      <AppIcon name="spinner" class="spin" />
      正在读取课程包…
    </p>

    <CoursePreviewDialog />
  </div>
</template>

<style scoped>
.course-mastery {
  display: grid;
  gap: var(--space-2);
  margin-bottom: var(--space-4);
  padding-bottom: var(--space-3);
  border-bottom: 1px solid var(--glass-border);
  font-size: var(--text-lg);
}
.course-mastery h3 {
  margin: 0;
  font-size: var(--text-lg);
}
.course-mastery-repos {
  display: grid;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}
.course-mastery-repos li {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.course-mastery small,
.course-mastery-empty {
  color: var(--text-secondary);
  font-size: var(--text-lg);
}
.course-mastery-empty {
  margin: 0;
}
.course-mastery-counts {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  margin: 0;
}
.count-mastered {
  color: var(--success);
}
.course-mastery > button {
  justify-self: start;
}
.course-columns {
  display: grid;
  grid-template-columns: minmax(220px, 1fr) minmax(360px, 3fr);
  gap: 20px;
  align-items: start;
}
.course-list-panel {
  display: grid;
  gap: var(--space-3);
  padding: var(--space-3);
}
.course-group {
  display: grid;
  gap: 4px;
}
.course-group h2 {
  margin: 0 0 2px;
  color: var(--text-muted);
  font-size: var(--text-sm);
  font-weight: 600;
}
.course-item {
  display: grid;
  gap: 2px;
  padding: 8px 10px;
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  color: var(--text);
  background: none;
  font: inherit;
  font-size: var(--text-sm);
  text-align: left;
  cursor: pointer;
}
.course-item:hover {
  background: var(--glass-bg-strong);
}
.course-item.active {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.course-item:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.course-item-title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-1);
}
.course-item small {
  color: var(--text-muted);
}
.course-item .trust-pending {
  color: var(--warning);
}
.scope-badge.in-use {
  color: var(--success);
  font-weight: 600;
}
.scope-badge.selected {
  color: var(--warning);
}
.course-detail-panel {
  min-width: 0;
}
.course-detail-panel .panel-heading p code {
  font-family: var(--font-mono);
  overflow-wrap: anywhere;
}
.course-detail-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--space-2);
}
.course-detail-body {
  display: grid;
  gap: var(--space-3);
  padding: 0 20px 20px;
}
.course-instructions {
  min-width: 0;
  padding-top: var(--space-3);
  border-top: 1px solid var(--line-soft);
  font-size: var(--text-sm);
}
.course-instructions summary {
  width: fit-content;
  color: var(--accent);
  font-weight: 600;
  cursor: pointer;
}
.course-instructions summary:hover {
  color: var(--accent-strong);
}
.course-instructions summary:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: var(--space-1);
  border-radius: var(--radius-sm);
}
.course-instructions > p {
  margin: var(--space-2) 0 0;
  color: var(--text-secondary);
  line-height: 1.6;
}
.course-state {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: 0;
  color: var(--text-secondary);
  font-size: var(--text-sm);
}
.course-state .icon {
  flex: none;
  width: 16px;
  height: 16px;
  color: var(--text-muted);
}
.course-state span {
  flex: 1;
}
.course-state.pending .icon {
  color: var(--warning);
}
.course-state.ok .icon {
  color: var(--success);
}
.course-copy {
  display: grid;
  gap: 6px;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--line-soft);
  border-radius: 12px;
  font-size: var(--text-sm);
}
.course-copy label {
  font-weight: 600;
}
.course-copy small {
  color: var(--text-muted);
}
.course-copy .course-field-error {
  color: var(--danger);
}
.course-copy-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}
</style>
