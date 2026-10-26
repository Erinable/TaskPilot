<script setup lang="ts">
// A course pack's whole content, as the agents will be told it. Before a
// repository or imported pack is confirmed, or a file is imported, every
// field is shown; when it changed since this machine confirmed it, the
// changes are listed first and marked, and confirming needs ticking that
// they were read. Text only: the pack is someone else's content.
import { computed, ref, watch } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import { FIELD_LABELS, SOURCE_LABELS, changeText, changedFields, dimensionLabel, sourcePath } from '@/lib/course_model.ts';
import { useCoursesStore } from '@/stores/courses.ts';

const courses = useCoursesStore();

const preview = computed(() => courses.preview);
const pack = computed(() => preview.value?.pack ?? null);
const changes = computed(() => preview.value?.changes ?? []);
const marked = computed(() => changedFields(changes.value));
const isMarked = (field: string) => marked.value.has(field);
const location = computed(() => (preview.value ? sourcePath(preview.value.ref.id, preview.value.ref.source, courses.list?.userDir ?? 'courses') : null));
const imported = computed(() => (courses.previewMode === 'import' ? (preview.value as { replaces: boolean; shadowed: boolean }) : null));
const asking = computed(() => courses.previewMode !== 'view');

// A changed pack is only confirmed after ticking that the changes were read.
const changesRead = ref(false);
watch(preview, () => {
  changesRead.value = false;
});
const needsTick = computed(() => courses.previewMode === 'confirm' && changes.value.length > 0);
const canAccept = computed(() => !courses.busy && (!needsTick.value || changesRead.value));

const GUIDES = ['tutorGuide', 'difficultyGuide', 'practiceGuide'] as const;

const accept = () => {
  const action = courses.previewMode === 'import' ? courses.importPicked() : courses.confirm();
  action.catch((error) => console.error(error));
};
</script>

<template>
  <el-dialog
    v-model="courses.previewOpen"
    class="task-modal glass-strong course-preview-dialog"
    :show-close="false"
    aria-labelledby="coursePreviewTitle"
    append-to-body
  >
    <template v-if="preview && pack">
      <button class="icon-button small modal-close" type="button" aria-label="关闭" @click="courses.closePreview()"><AppIcon name="x" /></button>
      <div class="modal-badge"><AppIcon name="blocks" /></div>
      <div class="modal-kicker">
        {{ courses.previewMode === 'import' ? '导入课程包' : courses.previewMode === 'confirm' ? '确认课程包' : '课程包' }}
      </div>
      <h2 id="coursePreviewTitle">{{ pack.title }}</h2>
      <p class="modal-intro">
        {{ pack.id }} · 版本 {{ pack.version }} · {{ SOURCE_LABELS[preview.ref.source] }}
        <template v-if="location">
          ·
          <code>{{ location }}</code>
        </template>
      </p>

      <p v-if="asking" class="course-warning" role="note">
        <AppIcon name="alert" />
        <span>下面每一项都会作为指令交给 Product Lead 和导师。请读完全部内容再继续；内容以后有变化，要重新确认。</span>
      </p>
      <p v-if="imported?.shadowed" class="course-warning" role="status">
        <AppIcon name="info" />
        <span>当前仓库也有一个 id 为 {{ pack.id }} 的课程包，在这个仓库里用的是仓库里的那个。</span>
      </p>
      <p v-if="imported?.replaces" class="course-warning" role="status">
        <AppIcon name="info" />
        <span>已经导入过 {{ pack.id }}，导入会替换它，替换后要重新确认。</span>
      </p>

      <section v-if="changes.length" id="courseChanges" class="course-changes" aria-label="改动">
        <strong>和本机上次确认的内容相比，改了 {{ changes.length }} 处：</strong>
        <ul>
          <li v-for="change in changes" :key="change.field" :data-change="change.field">{{ changeText(change) }}</li>
        </ul>
      </section>
      <p v-else-if="preview.previous === 'unknown' && preview.trust === 'pending'" class="course-warning" role="status">
        <AppIcon name="info" />
        <span>内容和上次确认时不同。上次确认时没有保存内容，列不出具体改了哪里，请完整读一遍。</span>
      </p>

      <dl class="course-fields">
        <div :class="{ changed: isMarked('summary') }">
          <dt>{{ FIELD_LABELS.summary }}</dt>
          <dd>{{ pack.summary }}</dd>
        </div>
        <div :class="{ changed: isMarked('domain') }">
          <dt>{{ FIELD_LABELS.domain }}</dt>
          <dd>{{ pack.domain }}</dd>
        </div>
        <div :class="{ changed: isMarked('learner') }">
          <dt>{{ FIELD_LABELS.learner }}</dt>
          <dd>{{ pack.learner }}</dd>
        </div>
        <div v-if="pack.appliesTo?.languages || isMarked('appliesTo')" :class="{ changed: isMarked('appliesTo') }">
          <dt>{{ FIELD_LABELS.appliesTo }}</dt>
          <dd>{{ pack.appliesTo?.languages?.join(', ') ?? '不限' }}</dd>
        </div>
        <div v-for="guide in GUIDES" :key="guide" :class="{ changed: isMarked(guide) }">
          <dt>{{ FIELD_LABELS[guide] }}</dt>
          <dd>
            <ul class="course-lines">
              <li v-for="(line, index) in pack[guide]" :key="index">{{ line }}</li>
            </ul>
          </dd>
        </div>
        <div :class="{ changed: isMarked('referenceGuide') }">
          <dt>{{ FIELD_LABELS.referenceGuide }}</dt>
          <dd>{{ pack.referenceGuide }}</dd>
        </div>
        <div :class="{ changed: isMarked('rubric') }">
          <dt>判卷维度</dt>
          <dd>
            <ul class="course-rubric">
              <li
                v-for="item in pack.rubric"
                :key="item.id"
                :data-rubric="item.id"
                :class="{ changed: [...marked].some((field) => field === `rubric.${item.id}` || field.startsWith(`rubric.${item.id}.`)) }"
              >
                <strong>{{ item.label }}</strong>
                <small>（{{ item.id }}，通用维度：{{ dimensionLabel(item.dimension) }}）</small>
                <p>{{ item.description }}</p>
                <ul v-if="item.examples" class="course-lines">
                  <li v-for="(example, index) in item.examples" :key="index">{{ example.observation }} → {{ example.betterWay }}</li>
                </ul>
              </li>
            </ul>
          </dd>
        </div>
      </dl>

      <label v-if="needsTick" class="course-tick">
        <input id="courseChangesRead" v-model="changesRead" type="checkbox" />
        我已经看过上面列出的改动
      </label>

      <div class="modal-actions">
        <button class="secondary-button" type="button" @click="courses.closePreview()">{{ asking ? '取消' : '关闭' }}</button>
        <button v-if="asking" class="primary-button" type="button" data-action="accept-course" :disabled="!canAccept" @click="accept">
          <AppIcon :name="courses.previewMode === 'import' ? 'plus' : 'check-circle'" />
          {{ courses.previewMode === 'import' ? '导入' : '确认使用' }}
        </button>
      </div>
    </template>
  </el-dialog>
</template>

<style>
/* Teleported, so not scoped. */
.el-dialog.course-preview-dialog {
  position: relative;
  width: min(680px, 100%);
  padding: 28px 30px 26px;
}
.el-dialog.course-preview-dialog .el-dialog__header {
  display: none;
}
.el-dialog.course-preview-dialog .el-dialog__body {
  max-height: 72vh;
  padding: 0;
  overflow-y: auto;
}
.course-preview-dialog .modal-intro code {
  font-family: var(--font-mono);
  overflow-wrap: anywhere;
}
.course-warning {
  display: flex;
  gap: var(--space-2);
  margin: var(--space-3) 0 0;
  color: var(--text-secondary);
  font-size: var(--text-sm);
}
.course-warning .icon {
  flex: none;
  width: 16px;
  height: 16px;
  margin-top: 2px;
  color: var(--warning);
}
.course-changes {
  margin-top: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--warning);
  border-radius: 12px;
  font-size: var(--text-sm);
}
.course-changes ul {
  margin: 6px 0 0;
  padding-left: 1.2em;
}
.course-fields {
  display: grid;
  gap: var(--space-2);
  margin: var(--space-3) 0 0;
  font-size: var(--text-sm);
}
.course-fields > div {
  padding: 6px 10px;
  border-left: 3px solid transparent;
  border-radius: 6px;
}
.course-fields .changed,
.course-rubric li.changed {
  border-left-color: var(--warning);
  background: color-mix(in srgb, var(--warning) 10%, transparent);
}
.course-fields dt {
  color: var(--text-muted);
  font-weight: 600;
}
.course-fields dd {
  margin: 2px 0 0;
  color: var(--text);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.course-lines,
.course-rubric {
  margin: 0;
  padding-left: 1.2em;
}
.course-rubric {
  display: grid;
  gap: 6px;
  padding-left: 0;
  list-style: none;
}
.course-rubric > li {
  padding: 4px 8px;
  border-left: 3px solid transparent;
  border-radius: 6px;
}
.course-rubric p {
  margin: 2px 0 0;
}
.course-tick {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-3);
  font-size: var(--text-sm);
}
</style>
